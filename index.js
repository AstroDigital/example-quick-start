'use strict';

var request = require('request');
var express = require('express');
var app = express();

/**
 * Information about the image we're looking for, both processing method and
 * center coordinates. These must be entered.
 *
 * List of methods can be found at https://api.astrodigital.com/v1/methods.
 */
var method = 'trueColor';
var imageCenter = [37.7577, -122.4376];

/**
 * User's email
 */
var email = '';

/**
 * API base URL and version
 */
var baseURL = 'https://api.astrodigital.com/v1';

/**
 * The imagery search interval in milliseconds
 * 1 day is an appropriate search interval
 */
var searchInterval = 24 * 60 * 60 * 1000;

/**
 * The system recheck interval in milliseconds
 * 10 minutes is an appropriate search interval
 */
var recheckInterval = 10 * 60 * 1000;

/**
 * The interval at which the web page will reload in milliseconds
 * 1 hour is an appropriate interval
 */
var pageReloadInterval = 1 * 60 * 60 * 1000;

/**
 * The port to serve the webpage on
 */
var port = process.env.PORT || 3000;

/**
 * A placeholder for the latest tiled image.
 */
var latestImage;

/**
 * Runs a search request with the Astro Digital API and returns the latest image
 * @param {function} callback - A callback, called with (err, response),
 * where `response` is the latest image ID.
 */
var runSearchRequest = function (callback) {
  var searchString = '/search/?search=' +
    'upperLeftCornerLatitude:[' + imageCenter[0] + '+TO+1000]+AND+' +
    'lowerRightCornerLatitude:[-1000+TO+' + imageCenter[0] + ']+AND+' +
    'lowerLeftCornerLongitude:[-1000+TO+' + imageCenter[1] + ']+AND+' +
    'upperRightCornerLongitude:[' + imageCenter[1] + '+TO+1000]+AND+' +
    'acquisitionDate:[2015-05-01+TO+2016-05-01]';

  request(baseURL + searchString, function (err, res, body) {
    if (err || res.statusCode !== 200) {
      err = err || 'Looks like we were unable to find any matches for your search.';
      return callback(err, null);
    }

    // Parse the response and get the scene ID for the latest image.
    var data = JSON.parse(body);
    var sceneID = data.results[0].sceneID.trim();
    callback(null, sceneID);
  });
};

/**
 * Queries the Astro Digital API to check the status of an image in the
 * processign pipeline.
 * @param {string} sceneID - A valid scene ID.
 * @param {function} callback - A callback, called with (err, status, mapID, sceneID),
 * where `status` is the status of the image in the pipeline, mapID is a
 * published map ID and sceneID is a valid scene ID.
 */
var getSceneStatus = function (sceneID, callback) {
  var url = baseURL + '/scenes?sceneID=' + sceneID;

  request(url, function (err, res, body) {
    if (err || res.statusCode !== 200) {
      return callback(err, null, null, null);
    }

    // Parse the response and determine scene status for the desired method.
    var data = JSON.parse(body);
    var numberOfScenes = data.count;
    for (var i = 0; i < numberOfScenes; i++) {
      var scene = data.results[i];
      if (scene.process_method.code === method) {
        if (scene.ready) {
          return callback(null, 'READY', scene.map_id, sceneID);
        } else {
          return callback(null, 'REQUESTED', null, sceneID);
        }
      }
    }

    // If we didn't find any matching scenes, it has not yet been requested.
    return callback(null, 'NOT_YET_REQUESTED', null, sceneID);
  });
};

/**
 * Request that the image be published via the Astro Digital API.
 * @param {string} sceneID - A valid scene ID.
 */
var publishScene = function (sceneID) {
  var formData = {
    satellite: 'l8',
    sceneID: sceneID,
    email: email,
    process: method
  };

  request.post({ url: baseURL + '/publish', formData: formData },
    function (err, res, body) {
      if (err || res.statusCode !== 200) {
        return console.error('Received a non-200 status code.', body, err);
      }
      return console.info('Image successfully queued for publishing.');
    });
};

/**
 * A simple passthrough to handle errors and call `handlSceneStatus`
 * @param {string} status - The status of the image in the processing pipeline
 * @param {string} mapIP - The published image's tiled map URL
 * @param {string} sceneID - A valid scene ID.
 */
var statusCallback = function (err, status, mapID, sceneID) {
  if (err) {
    return console.error(err);
  }

  handleSceneStatus(sceneID, status, mapID);
};

/**
 * Depending on where the image is in the processing pipeline, this will either
 * provide the latest image map URL, just check back in later or will request
 * that a new image be processed.
 * @param {string} sceneID - A valid scene ID.
 * @param {string} status - The status of the image in the processing pipeline
 * @param {string} mapIP - The published image's tiled map URL
 */
var handleSceneStatus = function (sceneID, status, mapID) {
  console.info('Just checked on the status of ' + sceneID + ' and it is ' +
    status + '.');
  switch (status) {
    case 'READY':
      // The image has been processed, save it so it can be rendered by the webpage.
      latestImage = mapID;
      return;
    case 'REQUESTED':
      // We need to check back later if the image is finished processing.
      setTimeout(function () {
        getSceneStatus(sceneID, statusCallback);
      }, recheckInterval);
      return;
    case 'NOT_YET_REQUESTED':
      // Request the image to be published and then check back later if the
      // image is finished processing.
      publishScene(sceneID);
      setTimeout(function () {
        getSceneStatus(sceneID, statusCallback);
      }, recheckInterval);
      return;
    default:
      return console.error('Unhandled scene status');
  }
};

/**
 * A simple passthrough to handle errors and call `getSceneStatus`
 * @param {string} sceneID - A valid scene ID.
 */
var handleSearchResult = function (err, sceneID) {
  if (err) {
    return console.error(err);
  }

  getSceneStatus(sceneID, function (err, status, mapID) {
    if (err) {
      return console.error(err);
    }

    handleSceneStatus(sceneID, status, mapID);
  });
};

/**
 * Just do a quick verification of necessary inputs.
 */
if (!email || email === '' ||
    !imageCenter || imageCenter[0] === '' || imageCenter[1] === '' ||
    !method || method === '') {
  console.error('Uh oh, you are missing some required input data');
  process.exit(1);
}

/**
 * This will run a search request, get the latest
 * image ID, check to see its status in the processing pipeline, execute
 * actions based on the status and will eventually update the `latestImage`
 * property when everything is done.
 *
 * It'll do this forever...
 */
runSearchRequest(handleSearchResult);
setInterval(function () {
  runSearchRequest(handleSearchResult);
}, searchInterval);

/*
 * Start a simple Express server running so that we can make a request to load
 * a dynamic page so we can see the latest imagery.
 */
app.use(express.static('public'));
app.set('view engine', 'html');
app.engine('.html', require('ejs').renderFile);
app.get('/', function (req, res) {
  var context = {
    sceneID: latestImage,
    imageCenter: imageCenter,
    pageReloadInterval: pageReloadInterval
  };
  res.render('index', context);
  console.info('Page reload requested, latest image is ' + latestImage + '.');
});
app.listen(port, function () {
  console.info('Web server started on port ' + port + '.\n');
});
