#!/usr/bin/env bash

valid_app_bundle() {
  [[ -d "$1/Contents/MacOS" && -f "$1/Contents/Info.plist" ]] &&
    find "$1/Contents/MacOS" -type f -perm -111 -print -quit | grep -q .
}

stage_app_bundle() {
  local source="$1"
  local destination="$2"
  local parent
  local name
  local staged

  if ! valid_app_bundle "$source"; then
    echo "Source app bundle is incomplete: ${source}" >&2
    return 1
  fi

  parent="$(dirname "$destination")"
  name="$(basename "$destination")"
  mkdir -p "$parent"
  staged="$(mktemp -d "${parent}/.${name}.staging.XXXXXX")" || return 1
  if ! ditto "$source" "$staged" || ! valid_app_bundle "$staged"; then
    rm -rf "$staged"
    echo "Could not stage a valid app bundle from ${source}." >&2
    return 1
  fi
  printf '%s' "$staged"
}

cleanup_staged_app_bundle() {
  local staged="$1"
  local name

  [[ -n "$staged" && -d "$staged" ]] || return 0
  name="$(basename "$staged")"
  [[ "$name" == .*".app.staging."* ]] || {
    echo "Refusing to remove an unexpected staging path: ${staged}" >&2
    return 1
  }
  rm -rf "$staged"
}

replace_staged_app_bundle() {
  local staged="$1"
  local destination="$2"
  local parent
  local name
  local backup_root=""
  local backup=""
  local had_previous=0

  if ! valid_app_bundle "$staged"; then
    echo "Staged app bundle is incomplete: ${staged}" >&2
    cleanup_staged_app_bundle "$staged"
    return 1
  fi

  parent="$(dirname "$destination")"
  name="$(basename "$destination")"
  if [[ -e "$destination" || -L "$destination" ]]; then
    backup_root="$(mktemp -d "${parent}/.${name}.previous.XXXXXX")" || {
      cleanup_staged_app_bundle "$staged"
      return 1
    }
    backup="${backup_root}/${name}"
    if ! mv "$destination" "$backup"; then
      if [[ (-e "$backup" || -L "$backup") && ! (-e "$destination" || -L "$destination") ]]; then
        if mv "$backup" "$destination"; then
          rmdir "$backup_root"
        else
          echo "Could not restore the existing app bundle; it remains recoverable at ${backup}." >&2
        fi
      elif [[ ! -e "$backup" && ! -L "$backup" ]]; then
        rmdir "$backup_root"
      else
        echo "The existing app bundle remains recoverable at ${backup}." >&2
      fi
      cleanup_staged_app_bundle "$staged"
      echo "Could not preserve the existing app bundle at ${destination}." >&2
      return 1
    fi
    had_previous=1
  fi

  if ! mv "$staged" "$destination"; then
    if [[ -e "$destination" || -L "$destination" ]]; then
      if ! rm -rf "$destination"; then
        if [[ "$had_previous" -eq 1 ]]; then
          echo "Replacement failed; the previous app bundle remains recoverable at ${backup}." >&2
        else
          echo "Replacement failed; remove the incomplete app bundle at ${destination} before retrying." >&2
        fi
        cleanup_staged_app_bundle "$staged"
        return 1
      fi
    fi
    if [[ "$had_previous" -eq 1 ]]; then
      if ! mv "$backup" "$destination"; then
        echo "Replacement failed; the previous app bundle remains recoverable at ${backup}." >&2
        cleanup_staged_app_bundle "$staged"
        return 1
      fi
      rm -rf "$backup_root"
    fi
    cleanup_staged_app_bundle "$staged"
    echo "Could not replace ${destination}; the previous app bundle was restored." >&2
    return 1
  fi

  if ! valid_app_bundle "$destination"; then
    rm -rf "$destination"
    if [[ "$had_previous" -eq 1 ]]; then
      if ! mv "$backup" "$destination"; then
        echo "Replacement failed; the previous app bundle remains recoverable at ${backup}." >&2
        cleanup_staged_app_bundle "$staged"
        return 1
      fi
      rm -rf "$backup_root"
    fi
    cleanup_staged_app_bundle "$staged"
    echo "Could not replace ${destination}; the previous app bundle was restored." >&2
    return 1
  fi

  if [[ "$had_previous" -eq 1 ]]; then
    rm -rf "$backup_root" || echo "Previous app bundle retained at ${backup}." >&2
  fi
}
