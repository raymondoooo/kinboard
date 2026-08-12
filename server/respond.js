// Turning a db-shim error into an HTTP response.
//
// The shim mirrors supabase-js, where asking for a single row and getting none
// is an *error* rather than an empty result. Route handlers uniformly did
// `if (error) return res.status(500)`, which quietly turned "you edited
// something that no longer exists" into "the server is broken" — the wrong
// status, an alarming message, and no way for the client to tell a stale
// reference apart from a real fault.

// Use on update/delete-by-id paths, where a missing row means the record was
// removed (often by another device a moment earlier). NOT for inserts: a
// freshly inserted row that comes back missing is a genuine server fault and
// must stay a 500.
function dbError(res, error, notFoundMessage = 'Not found') {
  if (error && error.notFound) return res.status(404).json({ error: notFoundMessage });
  return res.status(500).json({ error: error.message });
}

module.exports = { dbError };
