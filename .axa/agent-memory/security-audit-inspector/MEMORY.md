# Memory Index

- [Auth-provider integration audit checklist](project_provider_integration_audit_checklist.md) — the 6 wiring gaps every new provider (Codex/Ollama/DeepSeek) has repeated; check before signing off.
- [Credential storage trust model + 0600 caveat](project_credential_storage_trust_model.md) — third-party keys sit plaintext in ~/.claude.json; the 0o600 mode only applies to newly created files.
- [Source auto-update invariants + known holes](project_source_autoupdate_invariants.md) — the 4 guards that keep the self-updater off dev checkouts and out of the live binary.
