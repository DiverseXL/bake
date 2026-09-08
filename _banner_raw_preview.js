// Raw layout preview — cookie + "bake!" (no color)
const lines = [
  `   .-'''-.`,
  `  /  o  o \\`,
  ` |  o    o     bake!`,
  `  \\  o  o /`,
  `   \`-...-'`,
];

console.log("---RAW START---");
console.log(lines.join("\n"));
console.log("---RAW END---");
console.log("");
console.log("Spaces as ·:");
lines.forEach((l, i) => console.log(`${i + 1} [${l.replace(/ /g, "·")}]`));
