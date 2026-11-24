# Technical debt

Debt that the project has accepted on purpose. Each entry says where it came from, what it costs, and what would retire it. An entry leaves this file when its fix is merged.

## S8: label and section search sorts every match on each page

**Where it came from.** [PR #3](https://github.com/vytorrennan/todoist-enhanced/pull/3), merged as `9d7dbd3`, added `GET /api/v1/labels/search`, the paged `GET /api/v1/labels`, and `GET /api/v1/sections/search`. They page with `LIMIT` and `OFFSET`. The fourth review round of PR #3 flagged the cost. The owner accepted it as non-blocking debt, and PR #3 merged with it open.

**What happens.** The label queries order by `item_order`, and the section query orders by `project_id, section_order`. No index serves those orders for the filtered rows. The query plan for the label search is:

```
SEARCH labels USING INDEX labels_name (user_id=?) | USE TEMP B-TREE FOR ORDER BY
```

SQLite sorts every matching candidate before it applies the page limit. The name match runs as a SQL function, so it runs for every candidate on every page. A page's work therefore grows with the number of candidates, not with the page size.

**Benchmarks.** The benchmark ran better-sqlite3 in memory, with the statement shapes the server uses and page size 50. One candidate in three matches the query. Each page was timed with `performance.now()`. The run was a single pass per size, so the figures show the trend. They are not a precision measurement, and they exclude HTTP.

| Candidates per table | Pages | Matches | Label search, mean per page | Label search, first / slowest | Section search, mean per page | Section search, first / slowest |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 7 | 334 | 3.27 ms | 5.34 ms / 5.34 ms | 3.12 ms | 2.90 ms / 4.36 ms |
| 10,000 | 67 | 3,334 | 33.07 ms | 25.80 ms / 55.89 ms | 32.12 ms | 21.90 ms / 51.99 ms |

**Why it is accepted.** At realistic sizes a page takes a few milliseconds. Fixing the cost needs a schema migration and a new cursor format, and PR #3 kept its scope to the compatibility fixes. The README's known limitations list says the same.

**What would retire it.**

1. Benchmark larger sets, for example 50,000 and 100,000 candidates, and realistic label and section counts per person and per project.
2. Test candidate indexes with `EXPLAIN QUERY PLAN`: `labels (user_id, item_order)` and `sections (project_id, section_order)`, with `id` as the tie-breaker.
3. Move to keyset pagination only if those measurements justify it. A keyset cursor resumes after the last row's order and `id`. Clients already hold offset cursors from these routes, so the change needs a plan for them.

**Status.** Accepted and non-blocking. The fork has issues disabled, so this file is the tracking record.
