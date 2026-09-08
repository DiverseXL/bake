const bodies = (top) => [
  `        ${top}`,
  `       / o   *  o  \\`,
  `      (  * o   o (`,
  `       \\  o  * o   /`,
  `        \`-o.__.o-'`,
];

const tops = [
  [`.--'""'--.`, "current"],
  [`.---""---.`, "clean shine"],
  [`.--."".--.`, "dotted bumps"],
  [`.--""----.`, "lopsided left shine"],
  [`.----""--.`, "lopsided right shine"],
  [`.--~""~--.`, "tilde bumps"],
  [`.--..""--.`, "lumpy left"],
  [`.-'""`--.`, "classic oval"],
];

for (const [top, name] of tops) {
  console.log("--- " + name + " (" + top.length + " chars) ---");
  console.log(bodies(top).join("\n"));
  console.log("");
}
