
import PropTypes from "prop-types";
const OktaError = ({ error }) => (
  <div>
    <h1>Error</h1>
    <p>An error occurred: {error.message}</p>
  </div>
);

export default OktaError;

OktaError.propTypes = {
  error: PropTypes.shape({ message: PropTypes.string }),
};
