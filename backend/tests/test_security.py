"""Tests for the input-validation guards that prevent path traversal, USB id
injection, and malformed / non-domain XML from reaching libvirt."""
import pytest

from app.services import libvirt_svc as svc


@pytest.mark.parametrize("name", ["vm1", "my-vm", "my_vm", "My.VM-01", "a"])
def test_check_name_accepts_valid(name):
    assert svc._check_name(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "..",
        "../etc",
        "../../etc/passwd",
        "a/../b",
        "a/b",
        "/etc/passwd",
        "a b",
        "a;rm -rf /",
        "a$(whoami)",
        "-leading-dash",
        ".hidden",
        "",
    ],
)
def test_check_name_rejects_dangerous(name):
    with pytest.raises(ValueError):
        svc._check_name(name)


def test_check_name_rejects_non_string():
    with pytest.raises(ValueError):
        svc._check_name(None)  # type: ignore[arg-type]


@pytest.mark.parametrize("value", ["0x1d6b", "1d6b", "abcd", "0", "0xFFFF"])
def test_check_hex_id_accepts_valid(value):
    # Returns the value with any 0x prefix stripped.
    assert svc._check_hex_id(value) == value.replace("0x", "")


@pytest.mark.parametrize(
    "value",
    ["xyz", "12345", "1d6b; rm", "'/><script>", "", "0x", "g00d"],
)
def test_check_hex_id_rejects_invalid(value):
    with pytest.raises(ValueError):
        svc._check_hex_id(value)


def test_update_vm_xml_rejects_malformed():
    with pytest.raises(ValueError, match="Malformed XML"):
        svc.update_vm_xml("vm1", "<domain><name>oops</domain>")


def test_update_vm_xml_rejects_non_domain_root():
    with pytest.raises(ValueError, match="domain"):
        svc.update_vm_xml("vm1", "<pool type='dir'><name>x</name></pool>")


def test_update_vm_xml_accepts_valid_domain():
    # Well-formed <domain> passes validation and reaches the (faked) connection
    # without raising.
    svc.update_vm_xml("vm1", "<domain type='kvm'><name>vm1</name></domain>")
