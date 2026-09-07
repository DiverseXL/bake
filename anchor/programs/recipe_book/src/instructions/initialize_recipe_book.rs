use anchor_lang::prelude::*;

use crate::error::RecipeBookError;
use crate::state::RecipeBook;

#[derive(Accounts)]
#[instruction(target_program_id: Pubkey)]
pub struct InitializeRecipeBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    // Space: 8 (discriminator) + 32 + 32 + 8 + 1 = 81 bytes.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 32 + 32 + 8 + 1,
        seeds = [b"recipe_book", target_program_id.as_ref()],
        bump,
    )]
    pub recipe_book: Account<'info, RecipeBook>,

    pub system_program: Program<'info, System>,
}

pub fn handle(ctx: Context<InitializeRecipeBook>, target_program_id: Pubkey) -> Result<()> {
    let book = &mut ctx.accounts.recipe_book;
    require!(
        book.target_program_id == Pubkey::default(),
        RecipeBookError::RecipeBookAlreadyExists
    );

    book.target_program_id = target_program_id;
    book.authority = ctx.accounts.authority.key();
    book.entry_count = 0;
    book.bump = ctx.bumps.recipe_book;
    Ok(())
}
