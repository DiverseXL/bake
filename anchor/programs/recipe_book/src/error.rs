use anchor_lang::prelude::*;

#[error_code]
pub enum RecipeBookError {
    #[msg("A RecipeBook already exists for this target program")]
    RecipeBookAlreadyExists,

    #[msg("Signer is not the authority of this RecipeBook")]
    Unauthorized,

    #[msg("String exceeds maximum allowed length for this field (mismatch test)")]
    StringTooLong,
}
