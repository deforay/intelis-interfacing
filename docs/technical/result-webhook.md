# Result webhook

This page describes schema version 1 of the result webhook, introduced in
version 4.4.0. The webhook sends each stored result to one HTTP receiver as
JSON. It runs alongside MySQL and InteLIS delivery and reads none of their
state. Turn it on in [Settings](../guide/settings.md#result-forwarding).

## Request

```http
POST <receiver URL>
Content-Type: application/json; charset=utf-8
Accept: application/json, text/plain, */*
Cache-Control: no-store
Authorization: Bearer <token>
```

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| Receiver URL | `http` or `https` URL | The address of every request. The URL may carry a query string. It cannot carry credentials or a fragment. | none |
| Authentication | `none`, `bearer`, `basic`, `apikey` | `bearer` sends `Authorization: Bearer <token>`. `basic` sends `Authorization: Basic <base64 username:password>`. `apikey` sends `X-API-Key: <key>`. | `none` |
| Secret | string | A bearer token or API key contains visible ASCII characters only, without spaces. A Basic password contains no line breaks. | none |

The request does not follow redirects. A redirect counts as a failed delivery.
The request times out after 30 seconds.

A saved secret is reused only for the same authentication type and the same
origin (scheme, host and port). A new origin requires the secret again, for
**Send test** as well as for saving.

## Body

```json
{
  "schemaVersion": 1,
  "batchId": "0b6f5a4e-3c2d-4e1f-9a8b-7c6d5e4f3a2b",
  "sentAt": "2026-09-16T10:21:00.000Z",
  "test": false,
  "source": {
    "application": "intelis-interfacing",
    "appVersion": "4.4.0",
    "installationId": "interface-4d3c2b1a-0f9e-4d8c-b7a6-958473625140",
    "labId": "LAB001",
    "labName": "Central Laboratory"
  },
  "results": [
    {
      "id": 1842,
      "ingestion_id": "f2b6c1d0-8c1e-4a53-9a0d-1f6f1f2a3b4c",
      "instrument_id": "COBAS-6800",
      "machine_used": "COBAS-6800",
      "order_id": "VL-2026-00412",
      "test_id": "VL-2026-00412",
      "test_type": "HIVVL",
      "test_description": null,
      "test_location": null,
      "results": "<20",
      "test_unit": "cp/mL",
      "result_status": 1,
      "notes": null,
      "tested_by": "labtech1",
      "repeated": 0,
      "analysed_date_time": "2026-09-16 10:15:00",
      "specimen_date_time": null,
      "authorised_date_time": "2026-09-16 10:20:00",
      "result_accepted_date_time": null,
      "added_on": "2026-09-16 10:20:05",
      "raw_text": "R|1|^^^HIV-1|<20|cp/mL|..."
    }
  ]
}
```

### Envelope

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | integer | `1`. The version changes when a field changes meaning or is removed. |
| `batchId` | string (UUID) | New on every request, including a retry of the same results. |
| `sentAt` | string (ISO 8601, UTC) | The time the request was built. |
| `test` | boolean | `true` for **Send test** in Settings. A test request has an empty `results` array. |
| `source.application` | string | Always `intelis-interfacing`. |
| `source.appVersion` | string or null | The application version. |
| `source.installationId` | string or null | The installation's source identifier. |
| `source.labId` | string or null | **Testing Lab Code/ID** from Settings. |
| `source.labName` | string or null | **Testing Lab Name** from Settings. |
| `results` | array | 1 to 50 results. The results in a request total at most 1 MB of JSON, unless one result alone is larger. That result travels in a request of its own. |

### Result

Every value is the value stored in the `orders` table, unchanged. Text fields
are strings even when they look numeric. See
[what is stored, and where](storage.md) for each column.

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Local row ID. Unique on one installation only. |
| `ingestion_id` | string | Stable identity of the result. Identical on every retry. Use it to discard duplicates. |
| `instrument_id` | string or null | Instrument name configured in Settings. The column has integer affinity, so an all-digit name such as `0042` is stored, and sent, as `42`. |
| `machine_used` | string or null | Instrument the result came from. |
| `order_id` | string | Sample identifier as the analyzer sent it. |
| `test_id` | string or null | Test identifier as the analyzer sent it. |
| `test_type` | string or null | Assay. |
| `test_description` | string or null | Assay description, where the analyzer sends one. |
| `test_location` | string or null | Location, where the analyzer sends one. |
| `results` | string or null | The result as the analyzer sent it, for example `<20`, `Target Not Detected`, `1,25E+03`. |
| `test_unit` | string or null | Unit as sent. |
| `result_status` | integer or null | `1` final, `0` not final. |
| `notes` | string or null | Comment records. An errored run carries its explanation here. |
| `tested_by` | string or null | Operator recorded by the analyzer. |
| `repeated` | integer or null | Repeat flag. |
| `analysed_date_time` | string or null | As reported. |
| `specimen_date_time` | string or null | As reported. |
| `authorised_date_time` | string or null | As reported. |
| `result_accepted_date_time` | string or null | As reported. |
| `added_on` | string or null | The time this installation stored the result. |
| `raw_text` | string or null | The records the result was parsed from. |

## Response

| Receiver response | Effect |
|-------------------|--------|
| Any `2xx` status | Every result in the request is delivered. The body is ignored. |
| `400`, `413` or `422` for a request of more than one result | No result in the request is delivered. Each result in it is then sent in a request of its own. |
| Any other status | No result in the request is delivered. The results stay queued. |
| No response in 30 seconds, connection failure, or redirect | No result in the request is delivered. The results stay queued. |

When results are sent one at a time, each accepted result is delivered. A
refused result stays queued and is retried. If the first three single-result
requests are all refused, the remaining results in that request wait for the
next retry.

A failed request is retried after 30 seconds. Each further failure doubles the
wait, up to 15 minutes. While results are being delivered, the next page of
queued results is sent without waiting. A retry can deliver a result the receiver already
stored, for example when the receiver commits and then times out. The
`ingestion_id` of that result is unchanged.

## Delivery state

`orders.result_webhook_status` records delivery for each result.

| Value | Meaning |
|-------|---------|
| `0` | Pending. Sent while forwarding is on. |
| `1` | Delivered. A receiver answered `2xx`. |
| `2` | Not queued. Already stored when the forwarding settings were first saved. Never sent. |

The first save of the forwarding settings, with forwarding on or off, changes
every `0` to `2`. That save records `activatedAt`. Later saves change no
status. Results stored after the first save stay `0` while forwarding is off,
and are sent when it is on.

Changing the receiver URL does not resend delivered results. A request already
in flight when the URL changes completes against the previous receiver.

## Settings storage

The configuration is stored under `resultWebhook` in `config.json`. The secret
is encrypted with the operating system's credential store and is readable only
on this computer. Settings exports and automatic backups leave out
`resultWebhook`.

## Example receiver: Open Integration Engine or Mirth Connect

| Channel setting | Value |
|-----------------|-------|
| Source connector | HTTP Listener |
| Listener port | e.g. `8081` |
| Base context path | e.g. `/results` |
| Receive as | Text, with data type JSON |
| Response | `200` after the message is stored |
| Receiver URL in this tool | `http://<engine host>:8081/results` |

In the channel, iterate `msg.results`. Discard a result whose `ingestion_id`
the channel already processed. Skip messages where `msg.test` is `true`.
