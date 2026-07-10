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


# ---------------------------------------------------------------------------
# attach_disk: _check_path must reject unsafe paths before touching libvirt
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", [
    "/var/lib/libvirt/images/good.qcow2",
    "/data/vms/my-disk.img",
    "/tmp/test.raw",
])
def test_check_path_accepts_absolute_paths(path):
    assert svc._check_path(path) == path


@pytest.mark.parametrize("path", [
    "relative/path.qcow2",
    "disk.img",
    "./local.qcow2",
])
def test_check_path_rejects_relative_paths(path):
    with pytest.raises(ValueError, match="absolute"):
        svc._check_path(path)


@pytest.mark.parametrize("path", [
    "/var/lib/../etc/passwd",
    "/tmp/../root/secret",
    "/data/../../etc/shadow",
])
def test_check_path_rejects_traversal(path):
    with pytest.raises(ValueError, match=r"\.\.|traversal"):
        svc._check_path(path)


def test_check_path_rejects_non_string():
    with pytest.raises(ValueError):
        svc._check_path(None)  # type: ignore[arg-type]


def test_attach_disk_rejects_traversal_path():
    """attach_disk must call _check_path before reaching libvirt."""
    with pytest.raises(ValueError):
        svc.attach_disk("vm1", "/var/lib/../etc/passwd", None)


def test_attach_disk_rejects_relative_path():
    with pytest.raises(ValueError):
        svc.attach_disk("vm1", "relative/disk.qcow2", None)


# ---------------------------------------------------------------------------
# detach_usb: each half of vendor_id:product_id must pass _check_hex_id
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("usb_id", [
    "xyz:1234",
    "1234:xyz",
    "1d6b; rm:1234",
    "1234:1d6b; rm",
    "12345:abcd",
    "abcd:12345",
    ":1234",
    "1234:",
])
def test_detach_usb_rejects_invalid_hex_ids(usb_id):
    """detach_usb must validate both parts before touching libvirt."""
    with pytest.raises(ValueError):
        svc.detach_usb("vm1", usb_id)
