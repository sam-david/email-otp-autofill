# email-otp-autofill

A Chrome extension that fills in the verification code a site just emailed you. It reads the code from Gmail and matches it to the site you're on, like SMS code autofill on iOS and macOS but for email.

- Works with single code fields and split one-box-per-digit inputs.
- Read-only Gmail access, no backend; pages only ever receive the code.
- Optional Claude fallback for emails the built-in rules aren't sure about.

Setup, design and tests are in [`extension/README.md`](extension/README.md). `test-site/` is a local "check your inbox" page for testing against real Gmail.
