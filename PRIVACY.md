# Privacy

The Resumetron 9000 is software you run on your own computer. It has no server and no account with us, and it sends nothing to the project's authors.

## What stays on your computer

Your CV pool, goals, standing answers, application packets, ledger and logs live in your workspace folder (`~/.resumetron` by default). Credentials stay in environment variables or, for Google sign-in, in a token file in that workspace.

## What leaves your computer, and to whom

- **The model provider you choose** (for example Anthropic, OpenAI, or a local model) receives the text needed for each step: job postings, your CV pool, and drafts.
- **Job boards and employers** receive the applications you approve or allow it to submit, and the searches it runs against public job APIs.
- **Your own mailbox**, when you connect one:
  - It reads only messages whose headers point at one of your applications: employer replies and account-verification emails. It keeps a one-line record of each one (date, sender domain, subject, outcome), never the body.
  - It sends mail only to an address a job posting asks applications to go to, and only when your settings allow it.

## Google sign-in

When you connect Gmail with Google sign-in, the app asks for Gmail access (`https://mail.google.com/`) so it can do the reading and sending above. The token stays in your workspace on your computer and is used only by your copy of the app. Its use of information received from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. To revoke access, remove the app at https://myaccount.google.com/permissions and delete the token file.

## Contact

Open an issue at https://github.com/gavinlorenzo/resumetron-9000/issues.
