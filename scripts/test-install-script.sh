#!/usr/bin/env bash
#
# Drives scripts/install.sh against stand-ins for curl, apt-get and dpkg.
#
# WHY: this script is what every Debian and Ubuntu laboratory runs, on a
# machine that is already working, and its failure modes are the expensive
# kind -- an upgrade that removes the application it was replacing, or one that
# says "Installation completed" while the laboratory carries on running the
# version it had and nobody finds out until a result goes missing.
#
# Neither is visible by reading it. Both are one stubbed command away from
# being demonstrated.
#
# Nothing here runs in a subshell. An earlier version put each case in one, so
# a failed assertion incremented a copy of the count and the script exited 0
# with FAILED printed above it: a test that reports and does not fail is worse
# than no test, because the build stays green and someone has read the word
# "test" and stopped worrying.
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
failures=0
fake_dir=""
calls=""
output=""
status=0
# Conditions that expect evaluates once install.sh has run.
EXITED_ZERO='[[ ${status} -eq 0 ]]'
EXITED_NONZERO='[[ ${status} -ne 0 ]]'

# Builds a PATH of stand-ins: each records how it was called, and exits with the
# code the case under test asks for.
setup_fakes() {
  fake_dir="$(mktemp -d)"
  calls="${fake_dir}/calls"
  : > "${calls}"

  cat > "${fake_dir}/sudo" <<'FAKE'
#!/usr/bin/env bash
exec "$@"
FAKE

  cat > "${fake_dir}/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
target=""
while [[ $# -gt 0 ]]; do
  [[ "$1" == "-o" ]] && target="$2"
  shift
done
if [[ -n "$target" ]]; then
  printf 'not really a deb' > "$target"
else
  printf '{"browser_download_url": "https://example.test/intelis-interfacing_4.3.0_amd64.deb"}'
fi
FAKE

  cat > "${fake_dir}/apt-get" <<'FAKE'
#!/usr/bin/env bash
echo "apt-get $*" >> "$CALLS"
for argument in "$@"; do
  if [[ "$argument" == *.deb ]]; then
    exit "${APT_INSTALL_EXIT:-0}"
  fi
done
exit "${APT_FIX_EXIT:-0}"
FAKE

  cat > "${fake_dir}/dpkg" <<'FAKE'
#!/usr/bin/env bash
echo "dpkg $*" >> "$CALLS"
[[ "${1:-}" == "--remove" ]] && exit "${DPKG_REMOVE_EXIT:-0}"
exit "${DPKG_INSTALL_EXIT:-0}"
FAKE

  # INSTALLED is a list of "name=version" pairs describing the machine.
  # HALF_CONFIGURED names packages dpkg has unpacked but not configured, which
  # it still reports a version for -- the case a version check alone misreads.
  # The format string is rendered the way dpkg-query renders it, so the script
  # can ask for status and version in whichever shape it likes.
  cat > "${fake_dir}/dpkg-query" <<'FAKE'
#!/usr/bin/env bash
echo "dpkg-query $*" >> "$CALLS"
requested="${!#}"
format=""
for argument in "$@"; do
  [[ "$argument" == -f=* ]] && format="${argument#-f=}"
done
for entry in ${INSTALLED:-}; do
  if [[ "${entry%%=*}" == "$requested" ]]; then
    status="install ok installed"
    for unpacked in ${HALF_CONFIGURED:-}; do
      [[ "$unpacked" == "$requested" ]] && status="install ok unpacked"
    done
    for held in ${HELD:-}; do
      [[ "$held" == "$requested" ]] && status="hold ok installed"
    done
    rendered="${format//\$\{Status\}/$status}"
    rendered="${rendered//\$\{Version\}/${entry#*=}}"
    printf '%s' "$rendered"
    exit 0
  fi
done
exit 1
FAKE

  # The package as downloaded, read the way dpkg-deb is really called:
  # `dpkg-deb -f <path> <field>`, so the field is the third argument.
  cat > "${fake_dir}/dpkg-deb" <<'FAKE'
#!/usr/bin/env bash
echo "dpkg-deb $*" >> "$CALLS"
case "${3:-}" in
  Package) echo "intelis-interfacing" ;;
  Version) echo "4.3.0" ;;
esac
FAKE

  chmod +x "${fake_dir}"/*
  return 0
}

# Runs install.sh with the stand-ins in front of the real tools.
run_install() {
  setup_fakes
  output="$(CALLS="${calls}" PATH="${fake_dir}:${PATH}" bash "${root}/scripts/install.sh" 2>&1)"
  status=$?
  return 0
}

expect() {
  local description="$1" condition="$2"
  if eval "${condition}"; then
    echo "  ok  ${description}"
    return 0
  fi
  echo "  FAILED  ${description}"
  echo "----- exit ${status}; output -----"
  echo "${output}"
  echo "----- calls -----"
  cat "${calls}"
  echo "---------------------------------"
  failures=$((failures + 1))
}

echo "a machine with nothing installed yet"
INSTALLED="" APT_INSTALL_EXIT=0 APT_FIX_EXIT=0 run_install
expect "installs and reports success" "${EXITED_ZERO}"
expect "goes through apt in one transaction" 'grep -q "apt-get install -y" "${calls}"'
expect "removes nothing" '! grep -q "dpkg --remove" "${calls}"'
expect "says the databases update when the application next starts" 'grep -q "Version 4.3.0 is installed" <<< "${output}" && grep -q "next time the application starts" <<< "${output}"'

echo "a machine still carrying the package the tool shipped under before"
INSTALLED="vlsm-interfacing=4.1.15" APT_INSTALL_EXIT=0 APT_FIX_EXIT=0 run_install
expect "installs and reports success" "${EXITED_ZERO}"
expect "leaves the removal to apt rather than doing it first" '! grep -q "dpkg --remove" "${calls}"'

echo "an install that fails, with nothing broken for the repair to fix"
INSTALLED="vlsm-interfacing=4.1.15" APT_INSTALL_EXIT=100 APT_FIX_EXIT=0 run_install
# The expensive lie: the repair exits 0 because there is nothing to repair.
expect "does not report success" "${EXITED_NONZERO}"
expect "says the requested version is not installed" 'grep -q "requested version is not installed" <<< "${output}"'
expect "never removed what the laboratory was running" '! grep -q "dpkg --remove" "${calls}"'

echo "an upgrade of this same package that fails"
# The name is installed either way, so only the version tells the truth.
INSTALLED="intelis-interfacing=4.2.1" APT_INSTALL_EXIT=100 APT_FIX_EXIT=0 run_install
expect "does not mistake the older version for the new one" "${EXITED_NONZERO}"
expect "tells the operator how to check the machine" 'grep -q "apt-get -f install" <<< "${output}"'
expect "promises nothing about what was left behind" '! grep -q "has not been changed" <<< "${output}"'
expect "says nothing about the next start" '! grep -q "next time the application starts" <<< "${output}"'

echo "an install that unpacked the package but could not configure it"
# dpkg reports the new version for a package it has only unpacked, so the
# version alone would call a half-installed application a working one.
INSTALLED="intelis-interfacing=4.3.0" HALF_CONFIGURED="intelis-interfacing" \
  APT_INSTALL_EXIT=100 APT_FIX_EXIT=100 run_install
expect "does not call a half-installed package a working one" "${EXITED_NONZERO}"
expect "says the requested version is not installed" 'grep -q "requested version is not installed" <<< "${output}"'

echo "a package an administrator has pinned with apt-mark hold"
# dpkg reports "hold ok installed" for it. That is an administrator's intent,
# not a failure, and the application runs.
INSTALLED="intelis-interfacing=4.3.0" HELD="intelis-interfacing" \
  APT_INSTALL_EXIT=100 APT_FIX_EXIT=0 run_install
expect "recognises a held package as installed" "${EXITED_ZERO}"

echo "an install that fails and is then repaired"
INSTALLED="vlsm-interfacing=4.1.15 intelis-interfacing=4.3.0" HALF_CONFIGURED="" \
  APT_INSTALL_EXIT=100 APT_FIX_EXIT=0 run_install
expect "reports success once the requested version is really there" "${EXITED_ZERO}"
expect "says so plainly" 'grep -q "after dependency repair" <<< "${output}"'
expect "says the databases update when the application next starts" 'grep -q "next time the application starts" <<< "${output}"'

if [[ ${failures} -ne 0 ]]; then
  echo "install script: ${failures} case(s) failed."
  exit 1
fi

echo "install script: an upgrade that cannot proceed is never reported as one that did."
