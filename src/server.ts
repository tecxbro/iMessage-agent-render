import express from "express";

const server = express();

server.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

const port = Number(process.env.PORT || 10000);
server.listen(port, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${port}`);
});
