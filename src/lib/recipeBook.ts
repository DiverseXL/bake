/**
 * Swappable Recipe Book client.
 *
 * `bake deploy` talks only to this interface. The real client uses the checked-in
 * handwritten Anchor IDL; the mock remains available for isolated callers.
 *
 * Keypair / PublicKey / Connection use the classic @solana/web3.js v1 API
 * required by @coral-xyz/anchor.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, type AccountClient, type Idl } from "@coral-xyz/anchor";
import recipeBookIdl from "../idl/recipe_book.json" with { type: "json" };
import { getConnection } from "./connection.js";

export { Connection, Keypair, PublicKey };

export interface RecipeBookEntry {
  index: number;
  repo: string;
  commit: string;
  buildHash: Uint8Array;
  buffer: PublicKey;
  deployer: PublicKey;
  timestamp: number;
}

export interface RecipeBookClient {
  recipeBookExists(programId: PublicKey): Promise<boolean>;
  initializeRecipeBook(
    programId: PublicKey,
    authority: Keypair,
  ): Promise<{ signature: string }>;
  registerDeploy(
    programId: PublicKey,
    params: {
      repo: string;
      commit: string;
      buildHash: Uint8Array;
      buffer: PublicKey;
    },
    authority: Keypair,
  ): Promise<{ signature: string; entryIndex: number }>;
  getEntries(programId: PublicKey): Promise<RecipeBookEntry[]>;
}

interface OnChainRecipeBook {
  authority: PublicKey;
  entryCount: { toNumber(): number; toArrayLike<T>(constructor: typeof Buffer, endian: "le", length: number): T };
}

interface OnChainEntry {
  index: { toNumber(): number };
  repo: string;
  commit: string;
  buildHash: number[];
  buffer: PublicKey;
  deployer: PublicKey;
  timestamp: { toNumber(): number };
}

interface BookState {
  authority: string;
  entries: RecipeBookEntry[];
}

/**
 * In-memory stand-in. History lives only for the process lifetime — it is
 * NOT persisted on-chain.
 */
export class MockRecipeBookClient implements RecipeBookClient {
  private readonly books = new Map<string, BookState>();

  async recipeBookExists(programId: PublicKey): Promise<boolean> {
    return this.books.has(programId.toBase58());
  }

  async initializeRecipeBook(
    programId: PublicKey,
    authority: Keypair,
  ): Promise<{ signature: string }> {
    const key = programId.toBase58();
    if (this.books.has(key)) {
      throw new Error(`Recipe book already exists for ${key}`);
    }
    this.books.set(key, {
      authority: authority.publicKey.toBase58(),
      entries: [],
    });
    return { signature: "mock" };
  }

  async registerDeploy(
    programId: PublicKey,
    params: {
      repo: string;
      commit: string;
      buildHash: Uint8Array;
      buffer: PublicKey;
    },
    authority: Keypair,
  ): Promise<{ signature: string; entryIndex: number }> {
    const key = programId.toBase58();
    const book = this.books.get(key);
    if (!book) {
      throw new Error(`Recipe book does not exist for ${key}`);
    }
    const entryIndex = book.entries.length;
    book.entries.push({
      index: entryIndex,
      repo: params.repo,
      commit: params.commit,
      buildHash: new Uint8Array(params.buildHash),
      buffer: params.buffer,
      deployer: authority.publicKey,
      timestamp: Math.floor(Date.now() / 1000),
    });
    return { signature: "mock", entryIndex };
  }

  async getEntries(programId: PublicKey): Promise<RecipeBookEntry[]> {
    const book = this.books.get(programId.toBase58());
    return book ? [...book.entries] : [];
  }
}

type RecipeBookIdl = Idl & typeof recipeBookIdl;

class RealRecipeBookClient implements RecipeBookClient {
  private program(programId: PublicKey, authority: Keypair): Program<RecipeBookIdl> {
    const connection = getConnection();
    const provider = new AnchorProvider(
      connection,
      new Wallet(authority),
      AnchorProvider.defaultOptions(),
    );
    return new Program(recipeBookIdl as RecipeBookIdl, provider);
  }

  private accountClient(
    program: Program<RecipeBookIdl>,
    name: "recipeBook" | "entry",
  ): AccountClient {
    return (program.account as unknown as Record<string, AccountClient>)[name];
  }

  private recipeBookAddress(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("recipe_book"), programId.toBuffer()],
      new PublicKey(recipeBookIdl.address),
    )[0];
  }

  async recipeBookExists(programId: PublicKey): Promise<boolean> {
    const address = this.recipeBookAddress(programId);
    const account = await this.accountClient(
      this.program(programId, Keypair.generate()),
      "recipeBook",
    ).fetchNullable(address) as OnChainRecipeBook | null;
    return account !== null;
  }

  async initializeRecipeBook(
    programId: PublicKey,
    authority: Keypair,
  ): Promise<{ signature: string }> {
    const program = this.program(programId, authority);
    const recipeBook = this.recipeBookAddress(programId);
    const signature = await program.methods
      .initializeRecipeBook(programId)
      .accounts({ authority: authority.publicKey, recipeBook })
      .rpc();
    // Wait for the transaction to be confirmed before returning, so the
    // account is visible to subsequent reads (e.g. registerDeploy).
    const connection = getConnection();
    await connection.confirmTransaction(signature, "confirmed");
    return { signature };
  }

  async registerDeploy(
    programId: PublicKey,
    params: {
      repo: string;
      commit: string;
      buildHash: Uint8Array;
      buffer: PublicKey;
    },
    authority: Keypair,
  ): Promise<{ signature: string; entryIndex: number }> {
    const program = this.program(programId, authority);
    const recipeBook = this.recipeBookAddress(programId);
    const book = await this.accountClient(program, "recipeBook").fetch(recipeBook) as OnChainRecipeBook;
    const entry = PublicKey.findProgramAddressSync(
      [
        Buffer.from("entry"),
        recipeBook.toBuffer(),
        book.entryCount.toArrayLike(Buffer, "le", 8),
      ],
      new PublicKey(recipeBookIdl.address),
    )[0];
    const signature = await program.methods
      .registerDeploy(params.repo, params.commit, Array.from(params.buildHash), params.buffer)
      .accounts({
        deployer: authority.publicKey,
        recipeBook,
        authority: book.authority,
        entry,
      })
      .rpc();
    // Wait for the transaction to be confirmed so the entry is visible to
    // subsequent reads (e.g. getEntries in rollback).
    const connection = getConnection();
    await connection.confirmTransaction(signature, "confirmed");
    return { signature, entryIndex: book.entryCount.toNumber() };
  }

  async getEntries(programId: PublicKey): Promise<RecipeBookEntry[]> {
      const program = this.program(programId, Keypair.generate());
      const accounts = await this.accountClient(program, "entry").all() as Array<{
        account: OnChainEntry;
      }>;
    return accounts.map(({ account }) => ({
      index: account.index.toNumber(),
      repo: account.repo,
      commit: account.commit,
      buildHash: Uint8Array.from(account.buildHash),
      buffer: account.buffer,
      deployer: account.deployer,
      timestamp: account.timestamp.toNumber(),
    }));
  }
}

/**
 * Factory for the Recipe Book client used by `bake deploy`.
 */
export function getRecipeBookClient(): RecipeBookClient {
  return new RealRecipeBookClient();
}

export function isMockRecipeBookClient(client: RecipeBookClient): boolean {
  return client instanceof MockRecipeBookClient;
}
