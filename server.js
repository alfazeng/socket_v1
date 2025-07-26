// server.js
const WebSocket = require('ws');

// Render te asigna el puerto en process.env.PORT
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

wss.on('connection', function connection(ws) {
  console.log('Nuevo cliente conectado');

  ws.on('message', function incoming(message) {
    console.log('Mensaje recibido:', message);
    // Eco: envía de vuelta el mensaje al cliente
    ws.send(`Echo: ${message}`);
  });

  ws.on('close', function() {
    console.log('Cliente desconectado');
  });
});

console.log('WebSocket server running on port', port);
