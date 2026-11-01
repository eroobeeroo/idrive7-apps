#!/bin/bash
# The fork's tests (the same as app-tests.yml), run on an upstream merge before it is offered.
set -e
node kit/tools/test_runtime.js
node kit/tools/test_edrive_overlay.js
node kit/tools/test_edrive_live.js
node kit/tools/test_diag_options.js
node kit/tools/test_zh.js
