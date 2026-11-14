"""The one exception type tilekit raises for problems the user can fix."""


class TilekitError(Exception):
    """A problem with the model or the request; `detail` is JSON-serialisable context."""

    def __init__(self, message, detail=None):
        super().__init__(message)
        self.message = message
        self.detail = detail
