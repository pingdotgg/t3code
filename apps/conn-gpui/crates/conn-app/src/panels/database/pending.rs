//! SQL handed to a thread's Database panel before it can take it (`pendingByThreadKey` and
//! `takePending` in Conn's `databaseStore.ts` / `DatabasePanel.tsx`). A query waits, keyed by
//! its panel's owner (environment and thread), until that thread shows, its project's
//! connections have loaded and one is chosen.

use conn_state::PanelOwner;

/// Threads with a query waiting. A query leaves only on delivery or an explicit release; past
/// this, a new thread's query is refused and an accepted one never dropped.
const MAX_PENDING: usize = 32;

/// Why [`PendingQueries::queue`] refused a query.
pub(crate) const TOO_MANY_PENDING: &str = "Too many threads have a Database query waiting in Conn. Ask the user to open one of them, then try again.";

#[derive(Debug, Default)]
pub(super) struct PendingQueries {
    /// `(owner, sql)`, oldest first; one per owner, the latest wins.
    queries: Vec<(PanelOwner, String)>,
    /// Bumped by every Vault load, so only the newest one's answer counts.
    vault_load: u64,
    vault_loading: bool,
}

impl PendingQueries {
    /// Queues `sql` for `owner`, replacing what waited there. A new owner past
    /// [`MAX_PENDING`] is refused with [`TOO_MANY_PENDING`].
    pub(super) fn queue(&mut self, owner: &PanelOwner, sql: String) -> Result<(), &'static str> {
        if let Some((_, waiting)) = self.queries.iter_mut().find(|(o, _)| o == owner) {
            *waiting = sql;
            return Ok(());
        }
        if self.queries.len() >= MAX_PENDING {
            return Err(TOO_MANY_PENDING);
        }
        self.queries.push((owner.clone(), sql));
        Ok(())
    }

    /// A Vault load starts; returns its token.
    pub(super) fn begin_vault_load(&mut self) -> u64 {
        self.vault_load = self.vault_load.wrapping_add(1);
        self.vault_loading = true;
        self.vault_load
    }

    /// No Vault load is coming (none installed): every earlier one is stale.
    pub(super) fn end_vault_loads(&mut self) {
        self.vault_load = self.vault_load.wrapping_add(1);
        self.vault_loading = false;
    }

    /// The load `token` answered. `false` when a newer load started since: drop its answer.
    pub(super) fn finish_vault_load(&mut self, token: u64) -> bool {
        if token != self.vault_load {
            return false;
        }
        self.vault_loading = false;
        true
    }

    /// Takes `owner`'s query once the connections have loaded and one is chosen.
    pub(super) fn take(
        &mut self,
        owner: Option<&PanelOwner>,
        has_connection: bool,
    ) -> Option<String> {
        if self.vault_loading || !has_connection {
            return None;
        }
        let owner = owner?;
        let index = self.queries.iter().position(|(o, _)| o == owner)?;
        Some(self.queries.remove(index).1)
    }

    /// Drops a deleted thread's query.
    pub(super) fn forget(&mut self, owner: &PanelOwner) {
        self.queries.retain(|(waiting, _)| waiting != owner);
    }

    #[cfg(test)]
    pub(super) fn waiting(&self, owner: &PanelOwner) -> Option<&str> {
        self.queries
            .iter()
            .find(|(o, _)| o == owner)
            .map(|(_, sql)| sql.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(thread: &str) -> PanelOwner {
        PanelOwner::new("nick", thread)
    }

    #[test]
    fn a_query_waits_for_its_thread_and_a_connection() {
        let mut pending = PendingQueries::default();
        assert_eq!(pending.queue(&owner("a"), "select 1".into()), Ok(()));
        assert_eq!(
            pending.take(Some(&owner("b")), true),
            None,
            "another thread shows"
        );
        assert_eq!(
            pending.take(Some(&PanelOwner::new("mini", "a")), true),
            None,
            "the same thread id on another environment"
        );
        assert_eq!(
            pending.take(Some(&owner("a")), false),
            None,
            "no connection yet"
        );
        assert_eq!(pending.take(None, true), None);
        assert_eq!(
            pending.take(Some(&owner("a")), true).as_deref(),
            Some("select 1")
        );
        assert_eq!(
            pending.take(Some(&owner("a")), true),
            None,
            "delivered once"
        );
    }

    #[test]
    fn only_the_newest_vault_load_releases_a_query() {
        let mut pending = PendingQueries::default();
        let a = owner("a");
        let _ = pending.queue(&a, "select 2".into());
        let first = pending.begin_vault_load();
        // Refresh while the first load still runs.
        let second = pending.begin_vault_load();
        assert!(
            !pending.finish_vault_load(first),
            "the older answer is dropped"
        );
        assert_eq!(pending.take(Some(&a), true), None, "still loading");
        assert!(pending.finish_vault_load(second));
        assert_eq!(pending.take(Some(&a), true).as_deref(), Some("select 2"));
        // No Vault: an answer from before is stale and nothing waits on it.
        let _ = pending.queue(&a, "select 3".into());
        let stale = pending.begin_vault_load();
        pending.end_vault_loads();
        assert!(!pending.finish_vault_load(stale));
        assert_eq!(pending.take(Some(&a), true).as_deref(), Some("select 3"));
    }

    #[test]
    fn an_accepted_query_is_never_dropped_for_a_new_one() {
        let mut pending = PendingQueries::default();
        let a = owner("a");
        let _ = pending.queue(&a, "old".into());
        assert_eq!(pending.queue(&a, "new".into()), Ok(()));
        assert_eq!(
            pending.waiting(&a),
            Some("new"),
            "a thread's latest query wins"
        );
        for index in 1..MAX_PENDING {
            assert_eq!(
                pending.queue(&owner(&format!("t{index}")), "x".into()),
                Ok(())
            );
        }
        // The 33rd thread is refused; A, the first, still has its query.
        assert_eq!(
            pending.queue(&owner("t-last"), "x".into()),
            Err(TOO_MANY_PENDING)
        );
        assert_eq!(pending.waiting(&owner("t-last")), None);
        assert_eq!(pending.waiting(&a), Some("new"));
        assert_eq!(
            pending.queue(&a, "newer".into()),
            Ok(()),
            "a waiting thread can still replace its own"
        );
        // Once one is taken or released, there is room again.
        pending.forget(&owner("t1"));
        assert_eq!(pending.waiting(&owner("t1")), None);
        assert_eq!(pending.queue(&owner("t-last"), "x".into()), Ok(()));
        assert_eq!(pending.take(Some(&a), true).as_deref(), Some("newer"));
    }
}
