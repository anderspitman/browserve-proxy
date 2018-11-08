#!/usr/bin/env node

const WebSocket = require('ws');
const WebSocketStream = require('ws-streamify').default;
const args = require('commander');
const uuid = require('uuid/v4');
const Busboy = require('busboy');
const inspect = require('util').inspect;


class RequestManager {
  constructor(httpServer) {
    
    const wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws) => {

      const id = uuid();

      console.log("New ws connection: " + id);

      this._cons[id] = ws;

      ws.send(JSON.stringify({
        type: 'complete-handshake',
        id,
      }));

      ws.on('close', () => {
        console.log("Remove connection: " + id);
        delete this._cons[id];
      });
    });

    this._cons = {};

    this._nextRequestId = 0;

    this._responseStreams = {};
  }

  addRequest(id, res, options) {

    const requestId = this.getNextRequestId();

    this.send(id, {
      ...options,
      requestId,
    });

    this._responseStreams[requestId] = res;

    return requestId;
  }

  getNextRequestId() {
    const requestId = this._nextRequestId;
    this._nextRequestId++;
    return requestId;
  }

  send(id, message) {
    const ws = this._cons[id];
    if (ws) {
      if (ws.readyState == WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
      else {
        console.warn("Attempted to send when readyState = " + ws.readyState);
      }
    }
  }
}


args
  .option('-p, --port [number]', "Server port", 9001)
  .option('--cert [path]', "Certificate file path")
  .option('--key [path]', "Private key file path")
  .parse(process.argv);

const closed = {};

let httpServer;
if (args.cert && args.key) {
  const https = require('https');
  const fs = require('fs');

  const options = {
    key: fs.readFileSync(args.key),
    cert: fs.readFileSync(args.cert)
  };
  httpServer = https.createServer(options, httpHandler)
    .listen(args.port);
}
else {
  const http = require('http');
  httpServer = http.createServer(httpHandler).listen(args.port);
}

const requestManager = new RequestManager(httpServer);

const responses = {};

function httpHandler(req, res){
  console.log(req.method, req.url, req.headers);

  // enable CORS 
  res.setHeader("Access-Control-Allow-Origin", "*");
  //res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

  switch(req.method) {
    case 'GET': {
      
      const urlParts = req.url.split('/');
      const id = urlParts[1];
      const url = '/' + urlParts.slice(2).join('/');

      const options = {};

      if (req.headers.range) {

        options.range = {};

        const right = req.headers.range.split('=')[1];
        const range = right.split('-');
        options.range.start = Number(range[0]);

        if (range[1]) {
          options.range.end = Number(range[1]);
        }
      }

      console.log(options.range);
      const requestId = requestManager.addRequest(id, res, {
        type: 'GET',
        url,
        range: options.range,
      });

      responses[requestId] = res;


      req.connection.addListener('close', function() {
        console.log("conn closed: " + requestId);
      });

      break;
    }

    case 'POST': {
      console.log(req.url);

      if (req.url === '/command') {

        const command = {};

        const busboy = new Busboy({ headers: req.headers });

        busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
          command[fieldname] = val;
        });
        busboy.on('finish', function() {
          console.log(command);
          responses[command.requestId].writeHead(command.code, {'Content-type':'text/plain'});
          responses[command.requestId].write(command.message);
          responses[command.requestId].end();

          res.writeHead(200, {'Content-type':'text/plain'});
          res.write("OK");
          res.end();
        });
        req.pipe(busboy);
      }
      else if (req.url === '/file') {

        const settings = {};

        const busboy = new Busboy({ headers: req.headers });
        busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
          if (fieldname === 'hostId') {
            settings[fieldname] = val;
          }
          else {
            settings[fieldname] = Number(val);
          }
        });
        busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {

          console.log("effing settings");
          console.log(settings);

          if (settings.start) {
            let end;
            if (settings.end) {
              end = settings.end;
            }
            else {
              end = settings.fileSize - 1;
            }

            const len = end - settings.start;
            responses[settings.requestId].setHeader(
              'Content-Range', `bytes ${settings.start}-${end}/${settings.fileSize}`);
            responses[settings.requestId].setHeader('Content-Length', len + 1);
            responses[settings.requestId].setHeader('Accept-Ranges', 'bytes');
            responses[settings.requestId].statusCode = 206;
          }
          else {
            responses[settings.requestId].setHeader('Content-Length', settings.fileSize);
            responses[settings.requestId].setHeader('Accept-Ranges', 'bytes');
          }

          responses[settings.requestId].setHeader('Content-Type', 'application/octet-stream');

          responses[settings.requestId].setHeader('Content-Length', settings.fileSize);
          file.pipe(responses[settings.requestId]);
          console.log("after pipe");
          delete responses[settings.requestId];
        });
        busboy.on('finish', function() {
          console.log("finish /file");
          res.writeHead(200, {'Content-type':'text/plain'});
          res.write("/file OK");
          res.end();
        });
        req.pipe(busboy);
      }
      break;
    }

    case 'OPTIONS': {

      // handle CORS preflight requests
      res.writeHead(200, {'Content-type':'text/plain'});
      res.write("OK");
      res.end();
      break;
    }

    default: {
      res.writeHead(405, {'Content-type':'text/plain'});
      res.write("Method not allowed");
      res.end();
      break;
    }
  }
}
