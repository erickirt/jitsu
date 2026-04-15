You are reviewing a GitHub change set for bugs, security issues, correctness problems, and user-visible regressions.

Read `.github/codex/context/review-target.json` first. It tells you whether the subject is a pull request or a commit and which git range to inspect.

Review process:
1. Inspect the git diff for the provided range.
2. Open only the files needed to validate the diff.
3. Focus on actionable issues. Skip style, formatting, and low-value nits.
4. Only report findings you can defend from the code in this repository.
5. Keep the review concise.

Output requirements:
1. Write `.github/codex/output/review.json` with this exact schema:
```json
{
  "summary": "short overall summary",
  "body": "markdown body for the review",
  "findings": [
    {
      "severity": "high|medium",
      "title": "short finding title",
      "body": "concise markdown explanation with risk and suggested fix",
      "path": "relative/path/to/file.ext",
      "line": 123,
      "side": "RIGHT"
    }
  ]
}
```
2. `summary` must be a single sentence.
3. `body` must be valid Markdown and include a short heading plus either a short positive note or a short findings list.
4. Each finding must refer to a changed file. Use the most specific changed line you can justify.
5. Use `severity: "high"` only for issues that should block the change. Use `severity: "medium"` for non-blocking but still important issues.
6. If there are no findings, set `findings` to `[]` and make `body` explicitly say no blocking issues were found.
7. Also write `.github/codex/output/review.md` containing the same Markdown as `body`.

Do not post anything to GitHub yourself. Only write the two output files.
