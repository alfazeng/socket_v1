const WebSocket = require("ws");

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

wss.on("connection", function connection(ws) {
  console.log("Nuevo cliente conectado");
  ws.on("message", function incoming(message, isBinary) {
    if (isBinary) return;
    // Solo responde al remitente ("eco")
    ws.send("Echo: " + message.toString());
  });
  ws.on("close", function () {
    console.log("Cliente desconectado");
  });
});

console.log("WebSocket server running on port", port);
