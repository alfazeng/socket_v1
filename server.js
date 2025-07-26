const WebSocket = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

wss.on('connection', function connection(ws) {
  console.log('Nuevo cliente conectado');

  ws.on('message', function incoming(message, isBinary) {
    // Solo reenvía mensajes de texto (no binarios/blobs)
    if (isBinary) {
      console.log('Mensaje binario recibido y descartado.');
      return;
    }

    // Log y broadcast
    console.log('Mensaje recibido:', message.toString());

    // Reenviar el mensaje a TODOS los clientes conectados
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
