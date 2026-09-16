#!/usr/bin/env bash
#
# Install the latest InteLIS Interfacing release (Debian/Ubuntu, .deb).
#
# Quick install:
#   curl -fsSL https://raw.githubusercontent.com/deforay/intelis-interfacing/master/scripts/install.sh | bash
#
# Install a specific version (note the `bash -s --` to forward flags through the pipe):
#   curl -fsSL https://raw.githubusercontent.com/deforay/intelis-interfacing/master/scripts/install.sh | bash -s -- --tag v4.0.3
#
# If sudo prompts for a password, download first then run instead of piping:
#   curl -fsSL https://raw.githubusercontent.com/deforay/intelis-interfacing/master/scripts/install.sh -o install.sh && bash install.sh

set -euo pipefail

REPO_OWNER="deforay"
REPO_NAME="intelis-interfacing"

# The package name the tool shipped under before it was renamed. A machine that
# has it installed is upgraded rather than given a second copy: dpkg names a
# package after the product, so the rename would otherwise leave two
# applications, two menu entries and two services on the same machine.
LEGACY_PACKAGE_NAME="vlsm-interfacing"
TEMP_DOWNLOAD_DIR=""

cleanup_temp_download_dir() {
  if [[ -n "${TEMP_DOWNLOAD_DIR}" ]]; then
    rm -rf -- "${TEMP_DOWNLOAD_DIR}"
  fi
}

package_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

legacy_package_installed() {
  package_installed "${LEGACY_PACKAGE_NAME}"
}

# What the .deb itself declares, so what gets checked afterwards is what was
# actually meant to be installed rather than anything assumed from the filename.
field_from_deb() {
  dpkg-deb -f "$2" "$1" 2>/dev/null || true
}

# Status and version together, because either alone can mislead: the version is
# reported for a package that is only unpacked, and the status is reported for
# whatever version happens to be there.
installed_status_and_version() {
  dpkg-query -W -f='${Status}|${Version}' "$1" 2>/dev/null || true
}

# True only when the machine is running the exact package that was downloaded,
# and running it rather than merely holding it.
#
# WHY the version and not just the name: upgrading a machine that already has
# this package leaves the name installed whatever happens. An install that was
# rejected before it changed anything would look identical to one that
# succeeded, and the laboratory would be told it had upgraded while still
# running the version it had.
#
# WHY the status as well as the version: a package can be unpacked and then
# fail to configure. dpkg reports the new version for it either way, so the
# version alone would call a half-installed application a working one -- which
# is the state a laboratory is least able to diagnose and most likely to be
# sent back to work on.
downloaded_package_is_installed() {
  local package_path="$1" name version record

  name="$(field_from_deb Package "${package_path}")"
  version="$(field_from_deb Version "${package_path}")"
  [[ -n "${name}" && -n "${version}" ]] || return 1

  record="$(installed_status_and_version "${name}")"

  # dpkg reports three words: what is wanted for the package, whether it is in
  # an error state, and what is actually there. Only the last two say whether
  # the application will run. The first is an administrator's intent -- a
  # package someone has pinned with `apt-mark hold` reads "hold ok installed"
  # and works perfectly well -- and reading it as failure would tell a
  # laboratory its upgrade had not happened when it had.
  read -r _desired error_state current_state <<< "${record%%|*}"
  [[ "${error_state}" == "ok" && "${current_state}" == "installed" ]] || return 1

  [[ "${record#*|}" == "${version}" ]]
}

# Takes the machine off the package the tool shipped under before the rename.
#
# WHY this is needed at all: dpkg identifies a package by name, and the new
# name is a different package as far as it is concerned. Installing alongside
# the old one would leave both -- two entries in the applications menu, two
# copies in /opt, and an operator who cannot tell which one they just opened.
#
# WHY it is not simply done first: a laboratory that ends an upgrade with no
# application at all is worse off than one that never started it. apt can
# remove the old package and install the new one as a single transaction, and
# a failure part way through leaves the working application in place. That is
# the path taken whenever apt is available, which on Debian and Ubuntu is
# always. The fallback below only removes the old package once the new one has
# proved it cannot install any other way.
#
# The laboratory's data is untouched either way. Settings, the database and the
# backups live under the user's configuration directory, which the package
# manager neither owns nor removes -- and which the application names for
# itself precisely so a rename cannot move it.
remove_legacy_package() {
  if ! legacy_package_installed; then
    return
  fi

  echo "Removing the previous ${LEGACY_PACKAGE_NAME} package (your settings and results stay where they are)"
  sudo dpkg --remove "${LEGACY_PACKAGE_NAME}"
}

install_package() {
  local package_path="$1"

  if command -v apt-get >/dev/null 2>&1; then
    # One transaction: dependencies resolved, the superseded package removed if
    # it is there, and nothing removed at all if the install cannot proceed.
    echo "Installing ${package_path}"
    if sudo apt-get install -y "${package_path}"; then
      echo "Installation completed."
      return 0
    fi
    echo "apt-get could not install the package." >&2
    return 1
  fi

  # No apt on this machine. Try the install as it stands first, so a package
  # that cannot be installed for any other reason does not cost the laboratory
  # the copy it is running.
  echo "Installing ${package_path}"
  if sudo dpkg -i "${package_path}"; then
    echo "Installation completed."
    return 0
  fi

  if legacy_package_installed; then
    remove_legacy_package
    if sudo dpkg -i "${package_path}"; then
      echo "Installation completed."
      return 0
    fi
  fi

  return 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/install.sh [--download-dir <dir>] [--tag <tag>]

Examples:
  scripts/install.sh
  scripts/install.sh --tag v4.0.3
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

map_arch_to_asset_pattern() {
  case "$(uname -m)" in
    x86_64|amd64)
      echo 'amd64|x86_64'
      ;;
    aarch64|arm64)
      echo 'arm64|aarch64'
      ;;
    *)
      # WHY: if release assets do not embed the machine architecture in the
      # filename, we still want a usable fallback instead of failing early.
      echo ''
      ;;
  esac
}

find_release_asset_url() {
  local tag="$1"
  local arch_pattern="$2"
  local api_url
  local release_json
  local asset_url

  if [[ -n "$tag" ]]; then
    api_url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${tag}"
  else
    api_url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
  fi

  release_json="$(curl --proto '=https' --proto-redir '=https' -fsSL "${api_url}")"

  if [[ -n "$arch_pattern" ]]; then
    asset_url="$(printf '%s\n' "${release_json}" \
      | grep -Eo '"browser_download_url": "[^"]+\.deb"' \
      | cut -d'"' -f4 \
      | grep -Ei "${arch_pattern}" \
      | head -n1 || true)"
  fi

  if [[ -z "${asset_url:-}" ]]; then
    asset_url="$(printf '%s\n' "${release_json}" \
      | grep -Eo '"browser_download_url": "[^"]+\.deb"' \
      | cut -d'"' -f4 \
      | head -n1 || true)"
  fi

  if [[ -z "${asset_url:-}" ]]; then
    echo "No .deb asset found in the selected GitHub release." >&2
    exit 1
  fi

  printf '%s\n' "${asset_url}"
}

install_latest() {
  local download_dir=""
  local tag=""
  local arch_pattern
  local asset_url
  local package_name
  local package_path

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --download-dir)
        download_dir="$2"
        shift 2
        ;;
      --tag)
        tag="$2"
        shift 2
        ;;
      -h|--help|help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  require_command curl
  require_command dpkg

  arch_pattern="$(map_arch_to_asset_pattern)"
  asset_url="$(find_release_asset_url "${tag}" "${arch_pattern}")"
  package_name="$(basename "${asset_url}")"

  if [[ -z "${download_dir}" ]]; then
    download_dir="$(mktemp -d)"
    TEMP_DOWNLOAD_DIR="${download_dir}"
    trap cleanup_temp_download_dir EXIT
  else
    mkdir -p "${download_dir}"
  fi

  package_path="${download_dir}/${package_name}"

  echo "Downloading ${asset_url}"
  curl --proto '=https' --proto-redir '=https' -fL "${asset_url}" -o "${package_path}"

  if install_package "${package_path}"; then
    return
  fi

  # WHY: dpkg can leave dependency resolution incomplete for local .deb files.
  # apt-get -f install repairs dependencies and finishes package configuration.
  echo "The install reported a problem. Repairing dependencies with apt-get -f install..."
  sudo apt-get install -f -y || true

  # WHY this is checked rather than assumed: repairing dependencies succeeds
  # and exits 0 when there are no broken dependencies to repair, which is
  # exactly the case when the install failed for some other reason -- a damaged
  # download, the wrong architecture. Reporting that as a completed
  # installation would leave a laboratory believing it had upgraded while it
  # carried on running the version it had.
  if downloaded_package_is_installed "${package_path}"; then
    echo "Installation completed after dependency repair."
    return
  fi

  # WHY no reassurance here: an install can fail before it touched anything, or
  # after unpacking and before configuring. From outside there is no telling
  # which, and promising a laboratory that nothing changed when the package
  # manager is half way through would send them back to work on a machine
  # nobody has checked.
  echo "" >&2
  echo "The requested version is not installed." >&2
  echo "The usual causes are a download that did not complete, a package built" >&2
  echo "for another architecture, or a full disk." >&2
  echo "" >&2
  echo "Before using this machine again, check what state it is in:" >&2
  echo "  dpkg -l | grep -E 'intelis-interfacing|vlsm-interfacing'" >&2
  echo "A package listed as anything other than 'ii' is half installed. Finish" >&2
  echo "or undo it with:  sudo apt-get -f install" >&2
  exit 1
}

install_latest "$@"
