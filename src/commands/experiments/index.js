import fs from 'fs';
import path from 'path';
import sa from 'superagent';
import admZip from 'adm-zip';
import got from 'got';
import { templates } from './templates.js';
import { promiseFolderInit } from '../sites/index.js'; //useful utility function
import { readConfig } from '../prep/index.js'; //useful utility function
import replace from 'replace-in-file';
import jsYaml from 'js-yaml';
import util from 'util';
const exec = util.promisify(require('child_process').exec);
const shell = require('shelljs');
import pacMan from '../../pMan.js'; //which package manager is available?

// This may be overly restrictive in some cases
const isValidExpName = (name) => (/^([a-zA-Z])([a-zA-Z0-9_])*$/.test(name));

export function listExpTemplates() {
    return new Promise((resolve, reject) => {
    try { 
      resolve(templates.map((t) => (t.name)));
    } catch (e) { 
      console.error(`Something is wrong with experiments/templates.js, error: ${e}`); 
      process.exit(); 
    }
  })
}


const promiseExpFolderInit = async (initDir, dir, rootDir, modName, buildPath) => {
  //Similar to 'promiseFolderInit' in sites/index.js.
  //Modified to take advantage of yalc (not relevant for sites)
  return new Promise ((resolve, reject) => {
    console.log(`Installing dependencies for ${dir}`);
    try {
      exec(pacMan.concat(' install'), { cwd: path.join(initDir, dir) })
        .then(() => {
          console.log(`Building ${modName} from ${dir}`);
          exec(pacMan.concat(' run build'), { cwd: path.join(initDir, dir) })
            .then(() => {
              console.log(`${modName} is built`);
              exec('yalc publish', { cwd: path.join(initDir, dir) })
                .then(() => {
                  console.log(`${modName} is published locally via yalc`);
                  exec('yalc add '.concat(modName), { cwd: path.join(rootDir, buildPath) })
                    .then(() => {
                      console.log(`${modName} added to build cycle via yalc`);                  
                      resolve("built")
                    })
                })
            })
      })
    } catch (e) {
      console.error('Problem installing dependencies for ${dir}')
      throw(e)
    }
  })
}

export async function getExpTemplate(experimentsDir, templateName, longName, newExpName, rootDir) {
  if (!isValidExpName(newExpName)) {
    console.error(`'${newExpName}' is not a valid name. Names must start with a letter and can only contain alphanumeric characters.`);
    return;
  }
  console.log(`Making ${newExpName} in ${experimentsDir}`);
  const newDir = path.join(experimentsDir, newExpName);
  if (fs.existsSync(newDir) && fs.lstatSync(newDir).isDirectory()) {
    console.error(`A directory in the experiments folder already exists with this name (${newExpName})`);
    return;
  }

  // download files
  let url;
  for (const val in templates) {
    if (templates[val].name == templateName) {
      url = templates[val].url;
    }
  }
  if (!url) {
    console.error('Unable to download from specified site. Make sure your internet is on. If it is on but this error repeats, ask for help on the Pushkin forum.');
    return;
  }
  fs.mkdirSync(newDir);
  console.log(`retrieving from ${url}`);
  console.log('be patient...');
  let zipball_url;
  try {
    const response = await got(url);
    zipball_url = JSON.parse(response.body).assets[0].browser_download_url;
  } catch (error) {
    console.log(error.response.body);
    throw new Error('Problem parsing github JSON');
  }
  sa
    .get(zipball_url)
    .on('error', function(error){
      console.error('Download failed: ',error);
      process.exit();
    })
    .pipe(fs.createWriteStream('temp.zip'))
    .on('finish', async () => {
      console.log('finished downloading');
      var zip = new admZip('temp.zip');
      await zip.extractAllTo(newDir, true);
      await fs.promises.unlink('temp.zip');
      shell.rm('-rf','__MACOSX');
      await initExperiment(newDir, newExpName, longName, rootDir);
    })
}

const initExperiment = async (expDir, expName, longName, rootDir) => {
  const options = {
    files: expDir.concat('/**/*.*'),
    from: /pushkintemplate/g,
    to: expName,
  };
  try {
    const results = await replace(options)
  }
  catch (error) {
    console.error('Error occurred:', error);
  }

  //now that names are updated, load config
  let expConfig;
  try {
    expConfig = readConfig(expDir);
  } catch (err) {
    console.error(`Failed to read experiment config file for `.concat(exp));
    throw err;
  }
  expConfig.fullName = longName;
  try {
    fs.writeFileSync(path.join(expDir, 'config.yaml'), jsYaml.safeDump(expConfig), 'utf8');
  }
  const apiPromise = promiseExpFolderInit(expDir, expConfig.apiControllers.location, rootDir, expName.concat('_api'), 'pushkin/api').catch((err) => { console.error(err); });
  const webPromise = promiseExpFolderInit(expDir, expConfig.webPage.location, rootDir, expName.concat('_web'), 'pushkin/front-end').catch((err) => { console.error(err); });
  //note that Worker uses a different function, because it doesn't need yalc; it's published straight to Docker
  const workerPromise = promiseFolderInit(expDir, 'worker').catch((err) => { console.error(err); });

  // write out new compose file with worker service
  const composeFileLoc = path.join(path.join(rootDir, 'pushkin'), 'docker-compose.dev.yml');
  let compFile;
  try { 
    compFile = jsYaml.safeLoad(fs.readFileSync(composeFileLoc), 'utf8'); 
    console.log('loaded compFile')
  } catch (e) { 
    console.error('Failed to load main docker compose file: ',e);
    process.exit() 
  }
  await workerPromise //Need this to write docker-compose file

  const workerConfig = expConfig.worker;
  const workerService = workerConfig.service;
  const workerName = `${expName}_worker`.toLowerCase(); //Docker names must all be lower case
  const workerLoc = path.join(expDir, workerConfig.location);
  const serviceContent = { ...workerService, image: workerName };
  serviceContent.labels = { ...(serviceContent.labels || {}), isPushkinWorker: true };
  compFile.services[workerName] = serviceContent;
  let writeDC
  try {
    fs.writeFileSync(composeFileLoc, jsYaml.safeDump(compFile), 'utf8');
  } catch (e) { 
    console.error('Failed to create new compose file', e); 
    process.exit()
  }

  await Promise.all([apiPromise, webPromise])

  //Handle API includes
  //Need to read in controllers.json and append a controller to it.
  const controllersJsonFile = await JSON.parse(fs.promises.readFile(path.join(rootDir, 'pushkin/api/src/controllers.json')))
    .catch((e) => {
      console.error('Failed to load api/src/controllers.json', e);
      process.exit()
    })
  if (controllersJsonFile[])
  const writeAPI = fs.promises.writeFile(path.join(rootDir, 'pushkin/api/src/controllers.json'), JSON.stringify([]), 'utf8').catch((err) => console.error(err))

  try {
    fs.writeFileSync(path.join(rootDir, 'pushkin/api/src/controllers.json'), JSON.stringify(finalControllers), 'utf8')
  } catch (err) {
    console.error(`Failed to write api controllers list`)
    throw err;
  }

};

