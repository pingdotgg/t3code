//! Azure DevOps (`packages/source-control-azure-devops`): discovery through `az`.
//!
//! `az --version` and `az account show --query user.name -o tsv`, 20 s each because `az`
//! starts Python (`AzureDevOpsSourceControlProvider.discovery`). The server holds no Azure
//! credential: `az` uses its own login.
//!
//! Not ported: T3's Windows launcher (`azureCliLauncher.ts`); this server runs on macOS and
//! Linux only.

use std::time::Duration;

use conn_contract::{
    ServerProviderAuthStatus, SourceControlProviderAuth, SourceControlProviderDiscoveryItem,
};

use super::DiscoveryContext;
use crate::discovery::{
    CliSpec, ProbeContext, ProbeOutput, first_safe_auth_line, probe_cli, provider_auth,
};

pub const KIND: &str = "azure-devops";
const INSTALL_HINT: &str = "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.";

fn spec() -> CliSpec {
    CliSpec {
        kind: KIND,
        label: "Azure DevOps",
        executable: "az",
        version_args: &["--version"],
        auth_args: ["account", "show", "--query", "user.name", "-o", "tsv"]
            .map(str::to_owned)
            .to_vec(),
        auth_retry_args: None,
        probe_timeout: Duration::from_secs(20),
        install_hint: INSTALL_HINT,
    }
}

/// `parseAzureAuth`: only stdout names the account.
pub fn parse_auth(output: &ProbeOutput) -> SourceControlProviderAuth {
    let account = output
        .stdout
        .trim()
        .split('\n')
        .next()
        .map(|l| l.trim_end_matches('\r').trim())
        .unwrap_or_default();
    if output.exit_code != 0 {
        let detail = first_safe_auth_line(&output.combined())
            .unwrap_or_else(|| "Run `az login` to authenticate Azure CLI.".into());
        return provider_auth(
            ServerProviderAuthStatus::Unauthenticated,
            None,
            None,
            Some(&detail),
        );
    }
    if !account.is_empty() {
        return provider_auth(
            ServerProviderAuthStatus::Authenticated,
            Some(account),
            Some("dev.azure.com"),
            None,
        );
    }
    provider_auth(
        ServerProviderAuthStatus::Unknown,
        None,
        Some("dev.azure.com"),
        Some("Azure CLI account status could not be parsed."),
    )
}

pub async fn discover(ctx: DiscoveryContext<'_>) -> SourceControlProviderDiscoveryItem {
    let env = ctx.probe_env(&[]);
    probe_cli(
        ProbeContext {
            cwd: ctx.cwd,
            env: &env,
        },
        &spec(),
        parse_auth,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        discovery::{none, some, stub::StubDir},
        hosts::{Endpoints, Environment},
        settings::Settings,
    };

    // AzureDevOpsSourceControlProvider.test.ts: "reads the signed-in Azure account and says
    // when az is signed out"
    #[test]
    fn reads_the_account_and_sign_out() {
        let out = |stdout: &str, stderr: &str, exit_code| ProbeOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code,
        };
        let auth = parse_auth(&out("azure-user@example.com\n", "", 0));
        assert_eq!(
            auth.status,
            ServerProviderAuthStatus::Authenticated,
            "status"
        );
        assert_eq!(auth.account, some("azure-user@example.com"), "account");
        assert_eq!(auth.host, some("dev.azure.com"), "host");
        assert_eq!(auth.detail, none(), "detail");
        assert_eq!(
            parse_auth(&out("", "Please run 'az login' to setup account.\n", 1)).status,
            ServerProviderAuthStatus::Unauthenticated,
            "signed out"
        );
        assert_eq!(
            parse_auth(&out("\n", "", 0)).status,
            ServerProviderAuthStatus::Unknown,
            "unreadable"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runs_az_with_t3s_argv() {
        let stubs = StubDir::new("az");
        stubs.executable(
            "az",
            &[],
            "if [ \"$1\" = --version ]; then echo 'azure-cli 2.70.0'; exit 0; fi\necho 'azure-user@example.com'",
        );
        let settings = Settings::default();
        let env = Environment::fixed([]);
        let endpoints = Endpoints::default();
        let child_env = stubs.path_env();
        let item = discover(DiscoveryContext {
            cwd: &stubs.dir,
            home: None,
            settings: &settings,
            env: &env,
            endpoints: &endpoints,
            child_env: &child_env,
        })
        .await;
        assert_eq!(item.auth.account, some("azure-user@example.com"), "account");
        assert_eq!(item.version, some("azure-cli 2.70.0"), "version");
        let log = stubs.log("az");
        assert!(log.contains("argv --version\n"), "{log}");
        assert!(
            log.contains("argv account show --query user.name -o tsv\n"),
            "{log}"
        );
    }
}
