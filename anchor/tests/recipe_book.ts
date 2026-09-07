import * as anchor from "@coral-xyz/anchor";
import { expect, use } from "chai";
import chaiAsPromised from "chai-as-promised";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

use(chaiAsPromised);

describe("recipe_book", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.recipeBook as anchor.Program;
  const authority = provider.wallet.publicKey;

  function recipeBookPda(targetProgramId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("recipe_book"), targetProgramId.toBuffer()],
      program.programId
    )[0];
  }

  function entryPda(recipeBook: PublicKey, index: number): PublicKey {
    const indexBuffer = Buffer.alloc(8);
    indexBuffer.writeBigUInt64LE(BigInt(index));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), recipeBook.toBuffer(), indexBuffer],
      program.programId
    )[0];
  }

  function targetProgramId(): PublicKey {
    return Keypair.generate().publicKey;
  }

  async function initialize(target: PublicKey): Promise<PublicKey> {
    const recipeBook = recipeBookPda(target);
    await program.methods
      .initializeRecipeBook(target)
      .accounts({
        authority,
        recipeBook,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return recipeBook;
  }

  it("Test 1: initializes a RecipeBook with the authority and zero entries", async () => {
    const target = targetProgramId();
    const recipeBook = await initialize(target);
    const book = await program.account.recipeBook.fetch(recipeBook);

    expect(book.targetProgramId.toBase58()).to.equal(target.toBase58());
    expect(book.authority.toBase58()).to.equal(authority.toBase58());
    expect(book.entryCount.toNumber()).to.equal(0);
  });

  it("Test 2: rejects initializing the same target twice with RecipeBookAlreadyExists", async () => {
    const target = targetProgramId();
    const recipeBook = await initialize(target);

    await expect(
      program.methods
        .initializeRecipeBook(target)
        .accounts({
          authority,
          recipeBook,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    ).to.be.rejectedWith(/RecipeBookAlreadyExists/);
  });

  it("Test 3: registers a deploy from the authority and increments entry_count", async () => {
    const target = targetProgramId();
    const recipeBook = await initialize(target);
    const buildHash = Buffer.alloc(32, 1);
    const buffer = Keypair.generate().publicKey;

    await program.methods
      .registerDeploy("org/repo", "abcd1234", [...buildHash], buffer)
      .accounts({
        deployer: authority,
        recipeBook,
        authority,
        entry: entryPda(recipeBook, 0),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const book = await program.account.recipeBook.fetch(recipeBook);
    const entry = await program.account.entry.fetch(entryPda(recipeBook, 0));
    expect(book.entryCount.toNumber()).to.equal(1);
    expect(entry.recipeBook.toBase58()).to.equal(recipeBook.toBase58());
    expect(entry.index.toNumber()).to.equal(0);
    expect(entry.repo).to.equal("org/repo");
    expect(entry.commit).to.equal("abcd1234");
    expect(Buffer.from(entry.buildHash)).to.deep.equal(buildHash);
    expect(entry.buffer.toBase58()).to.equal(buffer.toBase58());
    expect(entry.deployer.toBase58()).to.equal(authority.toBase58());
    expect(entry.timestamp.toNumber()).to.be.greaterThan(0);
  });

  it("Test 4: rejects a deploy from a non-authority with Unauthorized", async () => {
    const target = targetProgramId();
    const recipeBook = await initialize(target);
    const other = Keypair.generate();
    const airdrop = await provider.connection.requestAirdrop(
      other.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop);

    await expect(
      program.methods
        .registerDeploy("org/repo", "abcd", new Array(32).fill(0), PublicKey.default)
        .accounts({
          deployer: other.publicKey,
          recipeBook,
          authority,
          entry: entryPda(recipeBook, 0),
          systemProgram: SystemProgram.programId,
        })
        .signers([other])
        .rpc()
    ).to.be.rejectedWith(/Unauthorized/);
  });

  it("Test 5: rejects a repo longer than 200 bytes with StringTooLong", async () => {
    const target = targetProgramId();
    const recipeBook = await initialize(target);

    await expect(
      program.methods
        .registerDeploy("a".repeat(201), "abcd", new Array(32).fill(0), PublicKey.default)
        .accounts({
          deployer: authority,
          recipeBook,
          authority,
          entry: entryPda(recipeBook, 0),
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    ).to.be.rejectedWith(/StringTooLong/);
  });

  it("Test 6: indexes two sequential deploys at 0 and 1 in order", async () => {
    const target = targetProgramId();
    const recipeBook = await initialize(target);

    await program.methods
      .registerDeploy("first/repo", "first-commit", new Array(32).fill(1), PublicKey.default)
      .accounts({
        deployer: authority,
        recipeBook,
        authority,
        entry: entryPda(recipeBook, 0),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await program.methods
      .registerDeploy("second/repo", "second-commit", new Array(32).fill(2), PublicKey.default)
      .accounts({
        deployer: authority,
        recipeBook,
        authority,
        entry: entryPda(recipeBook, 1),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const book = await program.account.recipeBook.fetch(recipeBook);
    const first = await program.account.entry.fetch(entryPda(recipeBook, 0));
    const second = await program.account.entry.fetch(entryPda(recipeBook, 1));
    expect(book.entryCount.toNumber()).to.equal(2);
    expect(first.index.toNumber()).to.equal(0);
    expect(first.repo).to.equal("first/repo");
    expect(second.index.toNumber()).to.equal(1);
    expect(second.repo).to.equal("second/repo");
  });
});
