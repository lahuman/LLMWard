# Third-Party Notices

## Reversible PII / Secret Pseudonymization Filter v3.2.5

LLMWard's built-in filter was independently designed with inspiration from
"Reversible PII / Secret Pseudonymization Filter v3.2.5" by Isidro Spencer.

Source:
https://openwebui.com/posts/reversible_pii_secret_pseudonymization_filter_v325_091de1cd

The LLMWard implementation does not copy the original runtime architecture.
It deliberately excludes process-global session maps, cross-session fallback,
debug content logging, broad recursive request mutation, Python, and Presidio.

MIT License

Author (as published): Isidro Spencer
Version (as published): 3.2.5
License (as published): MIT
The source page supplies no separate copyright notice or year; none is invented here.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
