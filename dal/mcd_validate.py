import datetime
import enum
from enum import auto
import math
from dataclasses import dataclass
from typing import Dict, Callable, Optional, List, TypeAlias

import pytz

from .mcd_model import FCState

# the purpose of this file is to provide you with a common validators for MCD database

Device: TypeAlias = Dict[str, any]

class FieldType(enum.Enum):
    FLOAT = auto()
    INT = auto()
    TEXT = auto()
    ISO_DATE = auto()
    CUSTOM_VALIDATOR = auto()


class Required(enum.Flag):
    """Determines if a field is optional or required in a certain device state"""
    OPTIONAL = 0                    # field is optional
    ALWAYS = 1 << 0                 # field is always required
    DEVICE_DEPLOYED = 1 << 1        # required when device is in a non-conceptual state
    OPTICAL_DATA_SELECTED = 1 << 2  # ray_tracing is selected and optical data should be there


class DeviceType(enum.Enum):
    """Defines what kind of device we are dealing with, so we can use the right validator for checking data before
       inserting it into db.

       NOTE: this is an append only enumeration. If you deprecate a device type, this device type enum
       should NEVER BE reused, or you will end up fetching invalid device type from history and validation will
       report it as a broken device when in fact was perfectly fine at the time of insertion.
    """
    # NOTE: the reason why we have Unset and Unknown device is to do the right thing during validation.
    #   0 - type usually means somebody forgot to set a type (which is a bug in MCD 2.0)
    #   1 - type means somebody set the type to Unknown on purpose and device data will not be validated
    #
    #   Alternatively we could use text instead of ints (which makes db easier to inspect at the cost of additional space)
    UNSET = 0
    UNKNOWN = 1
    MCD = 2
    SOURCE = 3
    BLANK = 4
    APERTURE = 5
    FLAT_MIRROR = 6
    KB_MIRROR = 7
    CRL = 8
    CRYSTAL = 9
    GRATING = 10


@dataclass(frozen=True)
class FieldValidator:
    name: str
    label: str
    data_type: FieldType
    required: Required = Required.OPTIONAL
    fromstr: Optional[Callable[[str], any]] = None
    range: Optional[List[float]] = None
    allowed_values: Optional[List[str] | List[int]] = None
    validator: Optional[Callable[[any], str]] = None  # custom validator if necessary

    @staticmethod
    def default_fromstr(field_type: FieldType, value: any):
        if field_type == FieldType.FLOAT:
            return float(value)
        if field_type == FieldType.INT:
            return int(value)
        if field_type == FieldType.TEXT:
            return str(value)
        if field_type == FieldType.ISO_DATE:
            return str2date(value)
        raise Exception(f"Unhandled field type {field_type.name} value from_str converter")

    def validate(self, value: any) -> str:
        try:
            if self.data_type == FieldType.CUSTOM_VALIDATOR and not self.validator:
                return f"field {self.name} demands a custom validator, but found none: this is a programming bug"

            if self.validator:
                err = self.validator(value)
                return err

            if self.fromstr:
                val = self.fromstr(value)
            else:
                val = self.default_fromstr(self.data_type, value)

            # validate range if possible
            if self.range and self.data_type in [FieldType.INT, FieldType.FLOAT]:
                if val < self.range[0] or val > self.range[1]:
                    return f"invalid range of '{self.name}' value: expected value range [{self.range[0]}, {self.range[1]}], but got {val}"

            if self.allowed_values:
                if val not in self.allowed_values:
                    return f"invalid '{self.name}' value '{val}': expected values are {self.allowed_values}"

            if self.data_type == FieldType.TEXT and self.required & Required.ALWAYS:
                if not val:
                    return f"invalid '{self.name}' value: value can't be empty"

            # no error
            return ""
        except Exception as e:
            return f"invalid '{self.name}' value: {str(e)}"

@dataclass
class Validator:
    """Base device validator for validating device fields"""
    name: str  # mcd, aperture, mirror, etc...
    fields: Dict[str, FieldValidator]

    def _find_required_fields(self, device_fields: Device):
        required_fields = set()
        device_state = device_fields.get("state", None)

        for name, validator in self.fields.items():
            if validator.required & Required.ALWAYS:
                required_fields.add(name)
                continue

            # NOTE: if device state does not exist (is None), an error will be raised
            # anyway for missing "state" since it's an ALWAYS required field
            if device_state and validator.required & Required.DEVICE_DEPLOYED:
                if device_state != FCState.Conceptual.value:
                    required_fields.add(name)
                    continue

            # TODO: other validation edge cases (e.g., for optics data)
        return required_fields

    def validate_device(self, device_fields: Device):
        """Validate all fields of a component (e.g., a flat mirror)."""
        if not isinstance(device_fields, dict):
            return f"invalid device data: expected a dictionary data type, but got {type(device_fields)}"

        required_fields = self._find_required_fields(device_fields)

        # validating entire component
        # 1) Validate that all provided keys are valid
        # 2) Validate provided values of component
        # 3) Validate that we didn't miss any of the required fields
        errors = []
        for field_name, field_val in device_fields.items():
            # remove field from required fields, so we know whether all required fields were present
            required_fields.discard(field_name)

            err = self.validate_field(field_name, field_val)
            if err:
                errors.append(err)

        # validation done
        if len(required_fields) != 0:
            missing_required_fields = sorted(list(required_fields))
            err = f"invalid device data: missing required fields: {missing_required_fields}"
            errors.append(err)

        if errors:  # report all errors at once
            return "\n".join(errors)
        return ""

    def validate_field(self, field: str, val: any) -> str:
        validator = self.fields.get(field, None)
        if validator is None:
            return f"{self.name} device does not contain field '{field}'"

        err = validator.validate(val)
        return err


class NoOpValidator(Validator):
    """Validator that accepts every change"""

    def validate_device(self, component_fields: Dict[str, any]):
        return ""

    def validate_field(self, field: str, val: any) -> str:
        return ""

class UnsetDeviceValidator(Validator):
    """This validator will always reject validation. If it's used, this usually means we have a programming bug
    and somebody forgot to set a device type."""

    def validate_device(self, component_fields: Dict[str, any]):
        return f"invalid device type {DeviceType.UNSET} (unset device): you have probably forgot to set a valid device type"

    def validate_field(self, field: str, val: any) -> str:
        return f"invalid device type {DeviceType.UNSET} (unset device): you have probably forgot to set a valid device type"


# --------------------------  converters --------------------------------

def no_transform(val: str):
    return val

def str2date(val: str):
    if isinstance(val, datetime.datetime):
        return val
    d = datetime.datetime.strptime(val, "%Y-%m-%dT%H:%M:%S.%fZ")
    return d.replace(tzinfo=pytz.UTC)


# ------------------------------- modelling validators ----------------------------------------

def build_validator_fields(field_validators: List[FieldValidator]) -> Dict[str, FieldValidator]:
    # if the validator fields are shared with another device, that's not a problem
    # since validators should be immutable and stateless.
    d = {}
    for v in field_validators:
        d[v.name] = v
    return d


validator_unset = UnsetDeviceValidator("Unset", fields=build_validator_fields([]))
validator_noop = NoOpValidator("Unknown", fields=build_validator_fields([]))

def validate_array_of_elements(field: str, input: any, validator: Validator) -> str:
    if not isinstance(input, list):
        return f"invalid '{field}' field: expected a list, but got {type(input)})"

    errors = []
    for i, element in enumerate(input):
        if not isinstance(element, dict):
            errors.append(f"invalid element[{i}] type: expected a dictionary, but got ({element})")
            continue

        err = validator.validate_device(element)
        if err:
            errors.append(f"failed to validate an element[{i}]: {err}: Original data: {element}")
            continue

    if errors:
        e = "\n".join(errors)
        return f"failed to validate '{field}' field: {e}"
    return ""

def validate_discussion_thread(input: any) -> str:
    err = validate_array_of_elements('discussion', input, discussion_thread_validator)
    return err

def validate_subdevices(input: any) -> str:
    err = validate_array_of_elements('subdevices', input, DEVICE_VALIDATOR)
    return err


discussion_thread_validator = Validator("Discussion", build_validator_fields([
    FieldValidator(name="id", label="id", data_type=FieldType.TEXT, required=Required.ALWAYS),
    FieldValidator(name="author", label="Author", data_type=FieldType.TEXT, required=Required.ALWAYS),
    FieldValidator(name="created", label="Created", data_type=FieldType.ISO_DATE, required=Required.ALWAYS),
    FieldValidator(name="comment", label="Comment", data_type=FieldType.TEXT, required=Required.ALWAYS),
]))

common_component_fields = build_validator_fields([
    FieldValidator(name="device_id", label="Device ID", data_type=FieldType.TEXT, required=Required.ALWAYS),
    # marks device type (mcd, mirror, aperture, ...)
    FieldValidator(name="device_type", label="Device Type", data_type=FieldType.INT, allowed_values=[t.value for t in DeviceType], required=Required.ALWAYS),
    # timestamp when change was introduced
    FieldValidator(name="created", label="Created", data_type=FieldType.ISO_DATE, required=Required.ALWAYS),
    # discussion thread that every device should support
    FieldValidator(name='discussion', label="Discussion", data_type=FieldType.CUSTOM_VALIDATOR, validator=validate_discussion_thread),
    # optional array of subdevices that could be present on any device
    FieldValidator(name='subdevices', label="Subdevices", data_type=FieldType.CUSTOM_VALIDATOR, validator=validate_subdevices)
])

validator_mcd = Validator("MCD", fields=common_component_fields | build_validator_fields([
    FieldValidator(name='fc', label="FC", data_type=FieldType.TEXT, required=Required.ALWAYS),
    FieldValidator(name='fg', label="FG", data_type=FieldType.TEXT),
    FieldValidator(name='tc_part_no', label="TC Part No.", data_type=FieldType.TEXT),
    FieldValidator(name='state', label="State", data_type=FieldType.TEXT, fromstr=str, allowed_values=[v.value for v in FCState], required=Required.ALWAYS),
    FieldValidator(name='stand', label="Stand/Nearest Stand", data_type=FieldType.TEXT),
    FieldValidator(name='comment', label="Comment", data_type=FieldType.TEXT),

    FieldValidator(name='nom_loc_x', label='Nom Loc X', data_type=FieldType.FLOAT, required=Required.DEVICE_DEPLOYED),
    FieldValidator(name='nom_loc_y', label='Nom Loc Y', data_type=FieldType.FLOAT, required=Required.DEVICE_DEPLOYED),
    FieldValidator(name='nom_loc_z', label='Nom Loc Z', data_type=FieldType.FLOAT, range=[0, 2000], required=Required.DEVICE_DEPLOYED),

    FieldValidator(name='nom_ang_x', label='Nom Ang X', data_type=FieldType.FLOAT, range=[-math.pi, math.pi], required=Required.DEVICE_DEPLOYED),
    FieldValidator(name='nom_ang_y', label='Nom Ang Y', data_type=FieldType.FLOAT, range=[-math.pi, math.pi], required=Required.DEVICE_DEPLOYED),
    FieldValidator(name='nom_ang_z', label='Nom Ang Z', data_type=FieldType.FLOAT, range=[-math.pi, math.pi], required=Required.DEVICE_DEPLOYED),

    FieldValidator(name='ray_trace', label='Ray Trace', data_type=FieldType.INT, range=[0, 1]),
]))

_mirror_geometry_fields = build_validator_fields([
    FieldValidator(name="geom_len", label="Geometry Length", data_type=FieldType.FLOAT),
    FieldValidator(name="geom_width", label="Geometry Width", data_type=FieldType.FLOAT),
    FieldValidator(name="thickness", label="Thickness", data_type=FieldType.FLOAT),
    FieldValidator(name="geom_center_x", label="Geometry Center X", data_type=FieldType.FLOAT),
    FieldValidator(name="geom_center_y", label="Geometry Center Y", data_type=FieldType.FLOAT),
    FieldValidator(name="geom_center_z", label="Geometry Center Z", data_type=FieldType.FLOAT),
])

_mirror_motion_range_fields = build_validator_fields([
    FieldValidator(name="motion_min_x", label="Motion Min X", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_max_x", label="Motion Max X", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_min_y", label="Motion Min Y", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_max_y", label="Motion Max Y", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_min_z", label="Motion Min Z", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_max_z", label="Motion Max Z", data_type=FieldType.FLOAT),

    FieldValidator(name="motion_min_pitch", label="Motion Min Pitch", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_max_pitch", label="Motion Max Pitch", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_min_roll", label="Motion Min Roll", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_max_roll", label="Motion Max Roll", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_min_yaw", label="Motion Min Yaw", data_type=FieldType.FLOAT),
    FieldValidator(name="motion_max_yaw", label="Motion Max Yaw", data_type=FieldType.FLOAT),
])

_mirror_tolerance_fields = build_validator_fields([
    FieldValidator(name="tolerance_x", label="Tolerance X", data_type=FieldType.FLOAT),
    FieldValidator(name="tolerance_y", label="Tolerance Y", data_type=FieldType.FLOAT),
    FieldValidator(name="tolerance_z", label="Tolerance Z", data_type=FieldType.FLOAT),
])

validator_flat_mirror = Validator("Flat Mirror", fields=validator_mcd.fields | _mirror_geometry_fields | _mirror_motion_range_fields | _mirror_tolerance_fields | build_validator_fields([
]))

validator_kb_mirror = Validator("KB Mirror", fields=validator_mcd.fields | _mirror_geometry_fields | _mirror_motion_range_fields | _mirror_tolerance_fields | build_validator_fields([
    FieldValidator(name="focus_min_p", label="Focus Min P", data_type=FieldType.FLOAT),
    FieldValidator(name="focus_max_p", label="Focus Max P", data_type=FieldType.FLOAT),

    FieldValidator(name="focus_min_q", label="Focus Min Q", data_type=FieldType.FLOAT),
    FieldValidator(name="focus_max_q", label="Focus Max Q", data_type=FieldType.FLOAT),

    FieldValidator(name="focus_theta", label="Focus Theta", data_type=FieldType.FLOAT),
]))

# TODO: do the same for all other devices...
validator_aperture = Validator("Aperture", fields=validator_mcd.fields | _mirror_geometry_fields | _mirror_motion_range_fields | build_validator_fields([
]))


class DeviceValidator(Validator):
    """This is a container for all validator types"""
    devices = {
        DeviceType.UNSET.value: validator_unset,
        DeviceType.UNKNOWN.value: validator_noop,
        DeviceType.MCD.value: validator_mcd,
        DeviceType.FLAT_MIRROR.value: validator_flat_mirror,
        DeviceType.KB_MIRROR.value: validator_kb_mirror,
        DeviceType.APERTURE.value: validator_aperture,
    }

    def __init__(self):
        self.name = "Device Validator"
        self.fields = {}

    def validate_field(self, field: str, val: any) -> str:
        raise Exception("this method should never be called on device validator: this is a programming bug")

    def validate_device(self, device: Device):
        device_type = device.get("device_type", None)
        if device_type is None:
            return "provided device does not have a required 'device_type' field"

        # or just display a giant switch here
        validator = DeviceValidator.devices.get(device_type, None)
        if validator is None:
            return f"can't validate provided device: device_type value '{device_type}' does not have an implemented validator"
        err = validator.validate_device(device)
        return err


# ------------------------------------- end of validator types --------------------------------


DEVICE_VALIDATOR = DeviceValidator()

@dataclass
class DeviceValidationError:
    device: Device
    error: str

@dataclass
class ValidationResult:
    ok: List[Device]
    errors: List[DeviceValidationError]

def validate_device(device: Device) -> str:
    return DEVICE_VALIDATOR.validate_device(device)

def validate_project_devices(devices: List[Device]) -> ValidationResult:
    """General method for validating project devices (on project import or when submitting the project for approval)"""
    results = ValidationResult([], [])
    for device in devices:
        validation_err = validate_device(device)
        if validation_err:
            results.errors.append(DeviceValidationError(device, validation_err))
            continue
        results.ok.append(device)
    return results


