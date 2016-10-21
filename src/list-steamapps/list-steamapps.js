'use strict';

const pify = require('pify');
const fs = pify(require('fs'), {exclude: ['createWriteStream']});
const path = require('path');

const entries = require('object.entries');
const envPaths = require('env-paths');
const flatCache = require('flat-cache');
const hyperquest = require('hyperquest');
const JSONStream = require('JSONStream');
const mkdirp = pify(require('mkdirp'));
const R = require('ramda');
const vdf = require('vdfjs');
const winreg = require('winreg');

const cachePath = envPaths('ayria', {suffix: ''}).cache;
const steamappsCache = flatCache.load('steamapps', cachePath);

// Return location of primary Steam library (installation directory)
// getSteamInstallPath :: () -> Promise -> String
const getSteamInstallPath = function () {
    if (process.platform === 'linux') {
        return Promise.resolve(envPaths('Steam', {suffix: ''}).data);
    }

    const steamRegistryKey = winreg({
        hive: winreg.HKCU,
        key: '\\SOFTWARE\\Valve\\Steam'
    });

    return new Promise(function (resolve, reject) {
        steamRegistryKey.get('SteamPath', function (error, result) {
            if (error) {
                reject(error);
            }

            resolve(result.value);
        });
    });
};

// Parses the `libraryfolders.vdf` config as found in the primary Steam library's steamapps directory
// getSteamLibraryFoldersConfig :: () -> Promise -> {Object}
const getSteamLibraryFoldersConfig = function () {
    return getSteamInstallPath().then(steamInstall => {
        const config = path.join(steamInstall, 'steamapps', 'libraryfolders.vdf');

        return fs.readFile(config, 'utf-8').then(vdf.parse);
    });
};

// Return location of all Steam libraries, including the installation directory
// getSteamLibraries :: () -> Promise -> [String]
const getSteamLibraries = function () {
    return Promise.all([getSteamInstallPath(), getSteamLibraryFoldersConfig()])
        .then(([steamInstall, settings]) => {
            const folders = entries(settings['LibraryFolders'])
                .filter(([key, _]) => key.match(/^\d+$/)) // Filter any non-numeric entries
                .map(([_, path]) => path); // Discards key from entries

            return [steamInstall].concat(folders);
        });
};

// Return each Steam libraries' steamapps directory
// getSteamappsPaths :: () -> [String]
const getSteamappsPaths = function () {
    return getSteamLibraries().then(libraries => libraries.map(library => {
        return path.join(library, 'steamapps');
    }));
};

// Return array of app ID's reading from files in the give given path
// getSteamappId :: String -> Promise -> [String]
const getSteamappId = function (path) {
    return fs.readdir(path).then(function (fileNames) {
        // Filter out non appmanifest fileNames
        fileNames = fileNames.filter(function (fileName) {
            return ~fileName.indexOf('appmanifest');
        });

        // Get the digits and thus app ID's out of the filename
        return fileNames.map(function (fileName) {
            return fileName.match(/\d+/)[0];
        });
    });
};

// Requests appInfo from the passed appId at the Steam API
// getSteamappInfo :: String -> Promise -> Object
const getSteamappInfo = function (appId) {
    const steamApiUrl = 'http://store.steampowered.com/api/appdetails?appids=';

    return new Promise(function (resolve, reject) {
        hyperquest(`${steamApiUrl}${appId}&filters=basic,background`)
          .pipe(JSONStream.parse('*'))
          .on('data', function (response) {
              // if response.data.background
              if (response.success) {
                  resolve(response.data);
              }
              reject('Steam API failed at responding.');
          })
          .on('error', function (error) {
              reject(error);
          });
    });
};

// Render passed object appData
// renderSteamapp :: Object -> ()
const renderSteamapp = function (appData) {
    const gamesListElement = document.querySelector('[data-list-games]');

    const appItem = document.createElement('li');
    const appContainer = document.createElement('figure');
    const appName = document.createElement('figcaption');
    const appBackground = document.createElement('img');

    // Fill in DOM nodes with data
    appName.textContent = appData.name;
    appBackground.src = appData.background;

    // Construct and insert DOM structure
    appItem.appendChild(appContainer);
    appContainer.appendChild(appName);
    appContainer.appendChild(appBackground);
    gamesListElement.appendChild(appItem);
};

// Takes steamappData, downloads the background and save the data to the cache
// cacheSteamappData :: Object -> Promise -> Object
const cacheSteamappData = function (appData) {
    const backgroundPath = path.join(cachePath, 'backgrounds');
    const appBackgroundPath = path.format({
        dir: backgroundPath,
        name: appData.steam_appid,
        ext: '.jpg'
    });

    steamappsCache.setKey(appData.steam_appid, appData);

    return new Promise(function (resolve, reject) {
        hyperquest(appData.background)
            .pipe(fs.createWriteStream(appBackgroundPath, {}))
            .on('finish', function () {
                appData.background = appBackgroundPath;
                resolve(appData);
            })
            .on('error', function (error) {
                // If directory doesn't exist create it and call again
                if (error.code === 'ENOENT') {
                    return mkdirp(backgroundPath)
                        .then(() => resolve(cacheSteamappData(appData)))
                        .catch(function (error) {
                            // If directory already exists call again
                            if (error.code === 'EEXIST') {
                                resolve(cacheSteamappData(appData));
                            } else {
                                reject(error);
                            }
                        });
                } else {
                    reject(error);
                }
            });
    });
};

getSteamappsPaths()
    .then(paths => Promise.all(paths.map(getSteamappId)))
    .then(R.unnest)
    .then(R.map(R.either(
        R.bind(steamappsCache.getKey, steamappsCache),
        R.pipeP(getSteamappInfo, cacheSteamappData)
    )))
    .then(R.forEach(function (appData) {
        Promise.resolve(appData).then(function (appData) {
            renderSteamapp(appData);
        });
    }))
    .then(steamapps => Promise.all(steamapps).then(() => {
        steamappsCache.save();
    }));
