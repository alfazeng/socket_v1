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
    // Si el mensaje es un Buffer, conviértelo a string
    const texto = typeof message === "string" ? message : message.toString();
    console.log("Mensaje recibido:", texto);
    console.log("Haciendo broadcast a", wss.clients.size, "clientes.");

    // BROADCAST como texto puro (no Buffer)
    wss.clients.forEach(function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(texto); // Forzamos que siempre sea texto
      }
    });
  });

  ws.on("close", function () {
    console.log("Cliente desconectado. Clientes activos:", wss.clients.size);
  });
});

console.log("WebSocket server running on port", port);
