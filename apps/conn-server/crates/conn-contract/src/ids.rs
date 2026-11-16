//! Branded string ids from `packages/contracts/src/baseSchemas.ts` and friends.
//! On the wire each is a plain JSON string.

macro_rules! string_id {
    ($($name:ident),* $(,)?) => {$(
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    )*};
}

string_id!(
    CommandId,
    ProjectId,
    ThreadId,
    RunId,
    RunAttemptId,
    NodeId,
    MessageId,
    TurnItemId,
    CheckpointId,
    RuntimeRequestId,
    ProviderInstanceId,
    ProviderSessionId,
    ProviderThreadId,
    ProviderTurnId,
);
