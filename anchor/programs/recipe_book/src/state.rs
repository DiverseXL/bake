use anchor_lang::prelude::*;

/// RecipeBook - one per deployed target program.
///
/// Space calculation:
///   8 (discriminator)
/// + 32 (target_program_id: Pubkey)
/// + 32 (authority: Pubkey)
/// + 8 (entry_count: u64)
/// + 1 (bump: u8)
/// = 81 bytes
#[account]
pub struct RecipeBook {
    pub target_program_id: Pubkey,
    pub authority: Pubkey,
    pub entry_count: u64,
    pub bump: u8,
}

/// Entry - one per deploy event, indexed 0..entry_count.
///
/// Space calculation:
///   8 (discriminator)
/// + 32 (recipe_book: Pubkey)
/// + 8 (index: u64)
/// + 4 + 200 (repo: String, max 200 bytes)
/// + 4 + 44 (commit: String, max 44 bytes)
/// + 32 (build_hash: [u8; 32])
/// + 32 (buffer: Pubkey)
/// + 32 (deployer: Pubkey)
/// + 8 (timestamp: i64)
/// + 1 (bump: u8)
/// = 405 bytes
#[account]
pub struct Entry {
    pub recipe_book: Pubkey,
    pub index: u64,
    pub repo: String,
    pub commit: String,
    pub build_hash: [u8; 32],
    pub buffer: Pubkey,
    pub deployer: Pubkey,
    pub timestamp: i64,
    pub bump: u8,
}
