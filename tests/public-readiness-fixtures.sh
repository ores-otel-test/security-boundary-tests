#!/usr/bin/env bash
set -euo pipefail

out=${1:?usage: public-readiness-fixtures.sh <output-dir>}
rm -rf "$out"
mkdir -p "$out"

seed_repo() {
  local root=$1
  mkdir -p "$root/.github" "$root/src/routes" "$root/public" "$root/docs/claims"
  printf '# Fixture repository\n' > "$root/README.md"
  printf 'Test-only fixture license.\n' > "$root/LICENSE"
  printf '# Test fixture instructions\nGenerated fixture copy is not product marketing.\n' > "$root/AGENTS.md"
  printf '# GitHub policy fixture\n' > "$root/.github/README.md"
}

rust_pass="$out/pass-rust-maud"
seed_repo "$rust_pass"
cat > "$rust_pass/src/routes/training.rs" <<'EOF'
fn page() -> &'static str {
    "SOC 2 readiness training. Readiness is not assurance; independent review remains separate."
}
EOF

negated_pass="$out/pass-negated-copy"
seed_repo "$negated_pass"
cat > "$negated_pass/public/readiness.html" <<'EOF'
<h1>Compliance readiness</h1>
<p>This is not an audit and does not offer guaranteed compliance or SOC 2 certified status.</p>
EOF

bad_marker="$out/fail-invalid-substantiation"
seed_repo "$bad_marker"
cat > "$bad_marker/public/training.html" <<'EOF'
<!-- ores-claim-substantiation: ../outside.md -->
<h1>SOC 2 readiness</h1>
<p>Readiness, not assurance. Independent audit remains separate.</p>
<p>Evidence review is 40% faster.</p>
EOF

bad_clean="$out/fail-guaranteed-clean"
seed_repo "$bad_clean"
cat > "$bad_clean/public/readiness.html" <<'EOF'
<h1>Audit readiness</h1>
<p>Independent assurance happens after readiness.</p>
<p>Guaranteed clean audit outcome for every customer.</p>
EOF

printf 'pass-rust-maud\npass-negated-copy\nfail-invalid-substantiation\nfail-guaranteed-clean\n'
