"""The `tilekit` command line: one JSON document on stdout, logs on stderr, exit 0 or 1.

To add a command, write a handler `(args) -> dict` and register it in `COMMANDS`
with a function that adds its options to a subparser.
"""

import argparse
import contextlib
import json
import logging
import sys
import traceback

from tilekit.cases import cases_json
from tilekit.checks import checks_json
from tilekit.config import load_model
from tilekit.errors import TilekitError
from tilekit.graph import graph_json
from tilekit.trace import trace_json

log = logging.getLogger("tilekit")


class NotImplementedYet(TilekitError):
    def __init__(self):
        super().__init__("not implemented yet")


class _Parser(argparse.ArgumentParser):
    """An ArgumentParser that raises instead of printing usage and exiting with code 2."""

    def error(self, message):
        raise TilekitError(f"{self.prog}: {message}", {"usage": self.format_usage().strip()})


# ---------------------------------------------------------------- handlers

def cmd_graph(args):
    return graph_json(load_model(args.model))


def cmd_cases(args):
    return cases_json(load_model(args.model))


def cmd_trace(args):
    if args.run or args.policy:
        if args.case or not (args.run and args.policy):
            raise TilekitError("trace takes either --case ID or --run RUN --policy ID")
        from tilekit.runs import trace_run_json
        return trace_run_json(load_model(args.model), args.run, args.policy)
    if not args.case:
        raise TilekitError("trace needs --case ID")
    return trace_json(load_model(args.model), args.case)


def cmd_check(args):
    return checks_json(load_model(args.model))


def cmd_build(args):
    if args.run or args.policy:
        if not (args.run and args.policy):
            raise TilekitError("build for real data needs both --run RUN and --policy ID")
        from tilekit.runs import build_policy
        return build_policy(load_model(args.model), args.run, args.policy, tile=args.tile, module=args.module,
                            whole_model=args.whole_model)
    from tilekit.build import build
    return build(load_model(args.model), tile=args.tile, module=args.module, whole_model=args.whole_model,
                 case=args.case, force=args.force)


def cmd_status(args):
    from tilekit.review import status_json
    return status_json(load_model(args.model))


def cmd_signoff(args):
    from tilekit.review import signoff
    return signoff(load_model(args.model), tile=args.tile, module=args.module, whole_model=args.whole_model,
                   reviewer=args.reviewer, comment=args.comment, values_only=args.values_only)


def cmd_reconfirm(args):
    from tilekit.review import reconfirm
    return reconfirm(load_model(args.model), args.reviewer, module=args.module, comment=args.comment)


def cmd_export(args):
    from tilekit.review import export
    return export(load_model(args.model), args.out, case=args.case)


def cmd_test(args):
    from tilekit.review import run_model_tests
    return run_model_tests(load_model(args.model), file=args.file)


def cmd_run(args):
    from tilekit.runs import run_portfolio
    return run_portfolio(load_model(args.model), args.model_points, args.name, id_column=args.id_column)


def cmd_runs(args):
    from tilekit.runs import list_runs
    return list_runs(load_model(args.model))


def cmd_policies(args):
    from tilekit.runs import policies_json
    return policies_json(load_model(args.model), args.run, sort=args.sort, desc=args.desc, limit=args.limit,
                         offset=args.offset, search=args.search, flag=args.flag)


def cmd_promote(args):
    from tilekit.runs import promote
    return promote(load_model(args.model), args.run, args.policy, args.id, args.name, purpose=args.purpose)


def cmd_init(args):
    from tilekit.init import init_model
    return init_model(args.model, args.name, package=args.package, tooling=args.tooling)


def cmd_sample_portfolio(args):
    from tilekit.samples import sample_portfolio
    return sample_portfolio(load_model(args.model), args.out, args.policies, seed=args.seed)


# ---------------------------------------------------------------- options

def no_options(parser):
    pass


def trace_options(parser):
    parser.add_argument("--case", metavar="ID")
    parser.add_argument("--run", metavar="RUN")
    parser.add_argument("--policy", metavar="ID")


def build_options(parser):
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--tile", metavar="T")
    target.add_argument("--module", metavar="M")
    target.add_argument("--whole-model", dest="whole_model", action="store_true",
                        help="build the model workbook")
    parser.add_argument("--case", metavar="ID", help="case of the model workbook (default: the default case)")
    parser.add_argument("--force", action="store_true", help="rebuild even when up to date")
    parser.add_argument("--run", metavar="RUN")
    parser.add_argument("--policy", metavar="ID")


def signoff_options(parser):
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--tile", metavar="T")
    target.add_argument("--module", metavar="M")
    target.add_argument("--whole-model", dest="whole_model", action="store_true")
    parser.add_argument("--reviewer", metavar="NAME", required=True)
    parser.add_argument("--comment", metavar="TEXT")
    parser.add_argument("--values-only", dest="values_only", metavar="REASON",
                        help="acknowledge that this tile cannot be written as an Excel formula (tiles only)")


def test_options(parser):
    parser.add_argument("--file", metavar="PATH", help="run one test file; the cached whole-suite result is untouched")


def reconfirm_options(parser):
    parser.add_argument("--reviewer", metavar="NAME", required=True)
    parser.add_argument("--module", metavar="M")
    parser.add_argument("--comment", metavar="TEXT")


def export_options(parser):
    parser.add_argument("--out", metavar="FILE", required=True)
    parser.add_argument("--case", metavar="ID", help="case of the workbook (default: the default case)")


def run_options(parser):
    parser.add_argument("--model-points", dest="model_points", metavar="FILE.csv", required=True)
    parser.add_argument("--name", metavar="RUN", required=True)
    parser.add_argument("--id-column", dest="id_column", metavar="COL", default="policy_id")


def policies_options(parser):
    parser.add_argument("--run", metavar="RUN", required=True)
    parser.add_argument("--sort", metavar="KEY")
    parser.add_argument("--desc", action="store_true")
    parser.add_argument("--limit", metavar="N", type=int)
    parser.add_argument("--offset", metavar="N", type=int, default=0)
    parser.add_argument("--search", metavar="TEXT")
    parser.add_argument("--flag", metavar="FLAG", help="uncovered, nan or undefined")


def promote_options(parser):
    parser.add_argument("--run", metavar="RUN", required=True)
    parser.add_argument("--policy", metavar="ID", required=True)
    parser.add_argument("--id", metavar="CASE", required=True)
    parser.add_argument("--name", metavar="NAME", required=True)
    parser.add_argument("--purpose", metavar="TEXT")


def init_options(parser):
    parser.add_argument("--name", metavar="NAME", required=True, help="the model's name")
    parser.add_argument("--package", metavar="PKG", help="Python package name (default: from the name)")
    parser.add_argument("--tooling", choices=("git", "path"), default="git",
                        help="how the model gets tilekit: pinned to this version's tag (default) or this machine's copy")


def sample_options(parser):
    parser.add_argument("--out", metavar="FILE.csv", required=True)
    parser.add_argument("--policies", metavar="N", type=int, required=True)
    parser.add_argument("--seed", metavar="S", type=int, default=0)


# name -> (handler, options, help)
COMMANDS = {
    "graph": (cmd_graph, no_options, "Model structure: layers, modules, quantities, edges"),
    "cases": (cmd_cases, no_options, "The named cases"),
    "trace": (cmd_trace, trace_options, "Every quantity's values for one case"),
    "check": (cmd_check, no_options, "Rule violations per tile"),
    "build": (cmd_build, build_options, "(Re)build stored workbooks"),
    "status": (cmd_status, no_options, "Review state of every tile, module and the model"),
    "signoff": (cmd_signoff, signoff_options, "Record a sign-off"),
    "reconfirm": (cmd_reconfirm, reconfirm_options, "Bulk re-confirm tiles with values-only drift"),
    "export": (cmd_export, export_options, "Copy the model workbook out"),
    "test": (cmd_test, test_options, "Run the model's own tests and cache the result"),
    "run": (cmd_run, run_options, "Run real model points"),
    "runs": (cmd_runs, no_options, "Stored real-data runs"),
    "policies": (cmd_policies, policies_options, "List policies in a run"),
    "promote": (cmd_promote, promote_options, "Make a synthetic case from a real policy"),
    "init": (cmd_init, init_options, "Create a new, empty model directory (--model DIR)"),
    "sample-portfolio": (cmd_sample_portfolio, sample_options,
                         "Write a SYNTHETIC portfolio CSV so the real-data feature can be tried without real data"),
}


def make_parser():
    parser = _Parser(prog="tilekit", description="Tools for reviewing tile-based Python models.")
    common = _Parser(add_help=False)
    common.add_argument("--model", default=".", metavar="DIR", help="the model directory (holds tilekit.toml)")
    common.add_argument("--verbose", action="store_true", help="debug logs on stderr")
    sub = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    for name, (handler, options, help_text) in COMMANDS.items():
        command = sub.add_parser(name, parents=[common], help=help_text, description=help_text)
        options(command)
        command.set_defaults(handler=handler)
    return parser


def _error_document(message, detail=None):
    error = {"message": message}
    if detail is not None:
        error["detail"] = detail
    return {"error": error}


def _serialise(document):
    return json.dumps(document, indent=2, allow_nan=False) + "\n"


def _emit(document):
    try:
        text = _serialise(document)
    except (TypeError, ValueError) as exc:
        text = _serialise(_error_document(f"{type(exc).__name__}: {exc}"))
    sys.stdout.write(text)
    sys.stdout.flush()


def main(argv=None):
    """Entry point; returns the exit code (and exits with it when run as a script)."""
    try:
        args = make_parser().parse_args(argv)
    except TilekitError as exc:
        _emit(_error_document(exc.message, exc.detail))
        return _exit(1, argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, stream=sys.stderr,
                        format="tilekit: %(message)s")
    try:
        with contextlib.redirect_stdout(sys.stderr):  # anything the model code prints goes to stderr
            document = args.handler(args)
            text = _serialise(document)
    except TilekitError as exc:
        log.error(exc.message)
        _emit(_error_document(exc.message, exc.detail))
        return _exit(1, argv)
    except Exception as exc:  # an unexpected failure (including one serialising the result) is still JSON
        log.error(traceback.format_exc())
        _emit(_error_document(f"{type(exc).__name__}: {exc}", {"traceback": traceback.format_exc()}))
        return _exit(1, argv)
    sys.stdout.write(text)
    sys.stdout.flush()
    return _exit(0, argv)


def _exit(code, argv):
    if argv is None:  # called from the console script
        sys.exit(code)
    return code
