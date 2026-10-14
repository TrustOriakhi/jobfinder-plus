import { chromium } from "playwright";
import { BROWSER_PROFILE_DIR } from "./config.js";
import { discover, refilter } from "./discover.js";
import { prepareShortlisted, runCycle } from "./pipeline.js";
import { scoreNew } from "./score.js";

const cmd = process.argv[2];

switch (cmd) {
  case "discover":
    await discover();
    break;
  case "refilter":
    refilter();
    break;
  case "score":
    console.log(await scoreNew());
    break;
  case "prepare":
    console.log(await prepareShortlisted());
    break;
  case "run":
    console.log(await runCycle("full"));
    break;
  case "login": {
    // Opens the bot's browser profile so you can sign in to job sites yourself; cookies persist.
    const ctx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, { headless: false });
    await ctx.pages()[0]?.goto(process.argv[3] ?? "https://www.google.com");
    console.log("Sign in to any sites you need, then close the browser window.");
    await new Promise((r) => ctx.on("close", r));
    break;
  }
  default:
    console.log("usage: tsx src/cli.ts discover | refilter | score | prepare | run | login [url]");
}
process.exit(0);
