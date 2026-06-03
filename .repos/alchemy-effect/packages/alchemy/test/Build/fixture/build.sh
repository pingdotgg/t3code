#!/bin/bash
mkdir -p dist
echo "Built at $(date)" > dist/output.txt
cp src/main.ts dist/main.ts
