import { printBanner } from "./src/lib/banner.ts";

console.log("--- printBanner() as the CLI will call it ---");
printBanner();
console.log("--- end ---");
console.log("isTTY=", process.stdout.isTTY);
console.log("argv=", process.argv);
