use anchor_lang::prelude::*;

use crate::error::RecipeBookError;
use crate::state::{Entry, RecipeBook};

const MAX_REPO_LEN: usize = 200;
const MAX_COMMIT_LEN: usize = 44;

#[derive(Accounts)]
#[instruction(repo: String, commit: String, _build_hash: [u8; 32], _buffer: Pubkey)]
pub struct RegisterDeploy<'info> {
    #[account(mut)]
    pub deployer: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ RecipeBookError::Unauthorized,
        seeds = [b"recipe_book", recipe_book.target_program_id.as_ref()],
        bump = recipe_book.bump,
    )]
    pub recipe_book: Account<'info, RecipeBook>,

    /// CHECK: has_one validates that this account is the stored authority.
    pub authority: UncheckedAccount<'info>,

    // Space: 8 + 32 + 8 + (4 + 200) + (4 + 44) + 32 + 32 + 32 + 8 + 1 = 405 bytes.
    #[account(
        init,
        payer = deployer,
        space = 8 + 32 + 8 + (4 + 200) + (4 + 44) + 32 + 32 + 32 + 8 + 1,
        seeds = [
            b"entry",
            recipe_book.key().as_ref(),
            recipe_book.entry_count.to_le_bytes().as_ref(),
        ],
        bump,
        constraint = repo.len() <= MAX_REPO_LEN @ RecipeBookError::StringTooLong,
        constraint = commit.len() <= MAX_COMMIT_LEN @ RecipeBookError::StringTooLong,
    )]
    pub entry: Account<'info, Entry>,

    pub system_program: Program<'info, System>,
}

pub fn handle(
    ctx: Context<RegisterDeploy>,
    repo: String,
    commit: String,
    build_hash: [u8; 32],
    buffer: Pubkey,
) -> Result<()> {
    let book = &mut ctx.accounts.recipe_book;
    require_keys_eq!(
        ctx.accounts.deployer.key(),
        book.authority,
        RecipeBookError::Unauthorized
    );

    let index = book.entry_count;
    let entry = &mut ctx.accounts.entry;
    entry.recipe_book = book.key();
    entry.index = index;
    entry.repo = repo;
    entry.commit = commit;
    entry.build_hash = build_hash;
    entry.buffer = buffer;
    entry.deployer = ctx.accounts.deployer.key();
    entry.timestamp = Clock::get()?.unix_timestamp;
    entry.bump = ctx.bumps.entry;

    book.entry_count = index + 1;
    Ok(())
}
