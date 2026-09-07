// Seed constants used in PDA derivations.
// The actual seeds are inline in the account constraints for clarity,
// but these are exported for client-side PDA derivation.
pub const RECIPE_BOOK_SEED: &[u8] = b"recipe_book";
pub const ENTRY_SEED: &[u8] = b"entry";
