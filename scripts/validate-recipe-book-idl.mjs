import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import idl from "../src/idl/recipe_book.json" with { type: "json" };

const programId = new PublicKey(idl.address);
const connection = new (await import("@solana/web3.js")).Connection(
  "http://127.0.0.1:8899",
  "confirmed",
);
const walletPath = "/home/my_pc/.config/solana/id.json";
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))),
);
const provider = new AnchorProvider(connection, new Wallet(authority), {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const program = new Program(idl, provider);
const targetProgramId = Keypair.generate().publicKey;
const [recipeBook] = PublicKey.findProgramAddressSync(
  [Buffer.from("recipe_book"), targetProgramId.toBuffer()],
  programId,
);

const before = await program.account.recipeBook.fetchNullable(recipeBook);
console.log(`fetchNullable before initialize: ${before === null ? "null" : "found"}`);

const signature = await program.methods
  .initializeRecipeBook(targetProgramId)
  .accounts({ authority: authority.publicKey, recipeBook })
  .rpc();
await connection.confirmTransaction(signature, "confirmed");

const after = await program.account.recipeBook.fetch(recipeBook);
console.log(`initialize signature: ${signature}`);
console.log(`initialized target: ${after.targetProgramId.toBase58()}`);

const [entry] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("entry"),
    recipeBook.toBuffer(),
    after.entryCount.toArrayLike(Buffer, "le", 8),
  ],
  programId,
);
const deploySignature = await program.methods
  .registerDeploy(
    "DiverseXL/bake",
    "idl-validation",
    Array.from(new Uint8Array(32)),
    programId,
  )
  .accounts({
    deployer: authority.publicKey,
    recipeBook,
    authority: authority.publicKey,
    entry,
  })
  .rpc();
await connection.confirmTransaction(deploySignature, "confirmed");
console.log(`register signature: ${deploySignature}`);
