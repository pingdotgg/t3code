#!/bin/bash

# install dependencies
direnv allow
corepack install
pnpm install

# setup repositories
git clone --depth 1 https://github.com/effect-ts/effect.git .repos/effect-old
git clone --depth 1 https://github.com/tstyche/tstyche.org.git .repos/tstyche.org

cat << EOF >> AGENTS.md

## Learning about "effect" v3

If you need to learn more about the old version of effect (version 3.x), you can
access the archived repository here:

\`.repos/effect-old\`

## Learning about the "tstyche" testing framework

If you need to learn more about the "tstyche" testing framework, you can access
the website repository here:

\`.repos/tstyche.org\`
EOF
