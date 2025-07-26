const WebSocket = require('ws');

// Render asigna el puerto automáticamente
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

wss.on('connection', function connection(ws) {
  console.log('Nuevo cliente conectado');

  ws.on('message', function incoming(message) {
    console.log('Mensaje recibido:', message);

    // Reenviar el mensaje a TODOS los clientes conectados (broadcast)
    wss.clients.forEach(function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on('close', function() {
    console.log('Cliente desconectado');
  });
});

console.log('WebSocket server running on port', port);
