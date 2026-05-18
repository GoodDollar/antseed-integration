import { config } from "./config.js";
import { createServer } from "./server.js";

const app = createServer(config);

app.listen(config.PORT, () => {
  console.log(`gooddollar-antseed-integration listening on :${config.PORT}`);
});
