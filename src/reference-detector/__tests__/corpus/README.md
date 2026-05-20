# Reference Detector Corpus

## What's here

`corpus-001` through `corpus-020` are **synthetic fixtures** committed to the repo. They cover all three detection signals (file-path match, block-ID mention, 40-char shingle), edge cases, true negatives, and the evaluation-order invariant.

The CI gate (`corpus.test.ts`) requires ≥ 20 entries and passes with these alone.

## Generating your local real-session corpus

Real-session fixtures (`corpus-021` and above) are **gitignored** — they contain your actual Claude Code session data and must never be pushed to remote.

To generate them locally (recommended before working on M5):

```bash
node scripts/extract-corpus.mjs
```

This will:
1. Walk your `~/.claude/projects/` JSONL session logs
2. Pair each assistant turn with the tool-result blocks in context
3. Run the three-signal detector against each pair
4. Write `corpus-021.json` through `corpus-100.json` (80 fixtures)

Once generated, the local test suite will run the precision/recall gate against all 100 entries. **Do not commit these files** — the `.gitignore` already prevents it.

### Options

```bash
# Limit to a specific session directory
node scripts/extract-corpus.mjs --sessions-dir ~/.claude/projects/my-project

# Generate more fixtures (beyond the default 80)
node scripts/extract-corpus.mjs --max-fixtures 150

# Dry run — print fixtures without writing files
node scripts/extract-corpus.mjs --dry-run
```

## Precision / recall thresholds

| Metric    | Threshold | File          |
|-----------|-----------|---------------|
| Precision | ≥ 95%     | REQ-NF-008    |
| Recall    | ≥ 85%     | REQ-NF-009    |

If your local corpus drops below either threshold after generation, investigate before starting M5.
