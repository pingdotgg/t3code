//! `assistantCitationsToPlainText` (`packages/shared/src/assistantCitations.ts`): a quote of
//! an earlier assistant reply becomes its text (and its comment) before a title prompt names
//! it. The parser lives in `conn_engine::citations`, which also expands citations for
//! providers.

pub use conn_engine::citations::to_plain_text as assistant_citations_to_plain_text;
