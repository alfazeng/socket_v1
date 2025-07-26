const WebSocket = require("ws");

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

wss.on("connection", function connection(ws) {
  console.log("Nuevo cliente conectado. Clientes activos:", wss.clients.size);

  ws.on("message", function incoming(message, isBinary) {
    if (isBinary) {
      console.log("Mensaje binario recibido y descartado.");
      return;
    }
    console.log("Mensaje recibido:", message.toString());
    console.log("Haciendo broadcast a", wss.clients.size, "clientes.");

   
    wss.clients.forEach(function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);

      }
    });
  });

  ws.on("close", function () {
    console.log("Cliente desconectado. Clientes activos:", wss.clients.size);
  });
});

console.log("WebSocket server running on port", port);
