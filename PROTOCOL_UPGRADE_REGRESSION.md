# Protocol Upgrade Minimal Regression

This document defines a minimal, repeatable regression workflow for Modbus protocol upgrades.

## Scope

The checks focus on high-risk protocol integration points:

1. Server register and bit mapping constants.
2. F2 sequence timing and read cadence.
3. Socket entry path (UI trigger to full F2 workflow).
4. DATA_READY mask consistency across server and client.
5. Client status register parsing for TEST_DONE, DATA_READY, and address bits.

## Script Entry

Run from repo root:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\protocol_regression_check.ps1
~~~

Run with full build verification:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\protocol_regression_check.ps1 -RunBuild
~~~

## Suggested Upgrade Workflow

1. Update protocol spec source files.
2. Update server constants and parsing.
3. Update polling and socket flow.
4. Update client masks and status parsing.
5. Run minimal regression script.
6. If script passes, run optional build verification.
7. Perform hardware or simulator smoke test for F2 end-to-end behavior.

## Pass Criteria

The script must report:

1. FAIL = 0
2. Optional build checks pass (when -RunBuild is used)

## Typical Failure Mapping

1. Missing mapping constant checks:
   - Recheck server file: webbattery_server/src/utils/modbusFrameUtils.ts

2. F2 timing checks fail:
   - Recheck server file: webbattery_server/src/services/pollingService.ts

3. Socket routing checks fail:
   - Recheck server file: webbattery_server/src/services/socketService.ts

4. Client mask checks fail:
   - Recheck client files:
     - webbattery_client/src/contexts/BatteryDataContext.tsx
     - webbattery_client/src/components/DataDisplay.tsx

## Extend Checklist for New Protocol Fields

When protocol adds new bits/registers:

1. Add constant checks in scripts/protocol_regression_check.ps1.
2. Add client parse checks if the field is shown in UI.
3. Add persistence checks if stored in DB.
4. Add one smoke test case in your manual test sheet.

## Notes

This is a minimal regression baseline, not a complete acceptance test.
Keep it strict, fast, and stable so it can run on every protocol revision.