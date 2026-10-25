.DEFAULT_GOAL := help

.PHONY: help install install-source pull

help:
	@printf '%s\n' \
		'make install         Install the latest desktop release' \
		'make install-source  Build and install the checked-out commit' \
		'make pull            Fetch and reset main to origin/main (discards tracked changes)'

install:
	node scripts/fork/install-desktop.ts

install-source:
	node scripts/fork/install-desktop.ts --from-source

pull:
	@test "$$(git branch --show-current)" = main || { echo 'Switch to main before running make pull.' >&2; exit 1; }
	git fetch origin
	git reset --hard origin/main
