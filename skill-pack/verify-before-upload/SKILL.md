---
name: verify-before-upload
description: Confirms a file's exact identity and properties before transforming, signing, or uploading it. Use before any repack, convert, or upload step: resolve and read back the full path, hash lookalike candidates, check properties against the destination's limits, keep the original untouched until the copy is verified, and ask the user when the canonical file is ambiguous.
metadata:
  version: "1.0.0"
---

# Verify Before Upload

Never transform, sign, convert, or upload a file you have not positively
identified. A wrong file uploaded with confidence costs far more than a
ten-second check.

## Confirm the exact file

- Resolve the full path of the file you are about to transform or
  upload, and read it back before you act on it.
- When two candidates share a name or a size, hash each one and compare
  the digests. Treat equal size as no proof of identity.
- Never trust a filename alone when a download folder and a project
  folder can hold different files under similar names.

## Inspect properties before choosing the path

- Check the properties that decide the upload path, such as aspect
  ratio and duration for video or page count and size for documents,
  before you pick a slot or format.
- Compare the file against the destination's limits, such as maximum
  size and accepted formats, before starting an upload you might have
  to redo.
- Keep the original file untouched until the transformed or uploaded
  copy is verified.

## Ask when ambiguous

- When you cannot tell which file is the canonical one, stop and ask
  the user to confirm before repacking, signing, or uploading.
- State the path and the distinguishing properties of each candidate
  so the user can pick without guessing.

## Make repeats cheap

- For uploads the user repeats daily, record the verified source path
  and expected properties in the workspace so later runs compare
  against them instead of rediscovering them.
