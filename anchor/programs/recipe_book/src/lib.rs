pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;
pub(crate) use instructions::initialize_recipe_book::__client_accounts_initialize_recipe_book;
pub(crate) use instructions::register_deploy::__client_accounts_register_deploy;

declare_id!("56Vj61zFW4hHV6wdjnisrHtVwWDqyjixjpBgnoRJvzxL");

#[program]
pub mod recipe_book {
    use super::*;

    pub fn initialize_recipe_book(
        ctx: Context<InitializeRecipeBook>,
        target_program_id: Pubkey,
    ) -> Result<()> {
        crate::instructions::initialize_recipe_book::handle(ctx, target_program_id)
    }

    pub fn register_deploy(
        ctx: Context<RegisterDeploy>,
        repo: String,
        commit: String,
        build_hash: [u8; 32],
        buffer: Pubkey,
    ) -> Result<()> {
        crate::instructions::register_deploy::handle(ctx, repo, commit, build_hash, buffer)
    }
}
// trivial change for rollback test
// second trivial change
// third trivial change
// deliberate mismatch test
